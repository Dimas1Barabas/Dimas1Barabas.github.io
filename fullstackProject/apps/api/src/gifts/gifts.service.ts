import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { EntityManager, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import {
  GiftCertificate,
  GiftDto,
  toGiftDto,
} from './gift-certificate.entity';
import { generateGiftCode, normalizeGiftCode } from './gift-code';
import {
  giftActivationRefusalError,
  giftExpiresAt,
  giftSpendAmount,
  nominalError,
} from './gifts.logic';

/** внутренний маркер «карта не списалась» — pay ловит и спрашивает причину */
export class GiftRefusedError extends Error {
  constructor(
    readonly code: string,
    readonly userId: string,
  ) {
    super(`gift ${code} refused`);
  }
}

/** ответ GET /gifts/my: мои карты, подаренные коды и итоги */
export class GiftsMyDto {
  @ApiProperty({
    type: [GiftDto],
    description: 'активированные мной карты (живые и потраченные), свежие сверху',
  })
  cards!: GiftDto[];

  @ApiProperty({
    type: [GiftDto],
    description: 'купленные мной и ещё не активированные — коды, которые нужно передать',
  })
  given!: GiftDto[];

  @ApiProperty({
    type: Object,
    description: 'итоги: availableRub (живой остаток) / cards / given',
  })
  totals!: { availableRub: number; cards: number; given: number };
}

@Injectable()
export class GiftsService {
  private readonly logger = new Logger(GiftsService.name);

  constructor(
    @InjectRepository(GiftCertificate)
    private readonly certs: Repository<GiftCertificate>,
  ) {}

  /**
   * Покупка сертификата: номинал проверен логикой (границы и кратность),
   * оплата — на кассе сайта (деньги симулируются, как во всём проекте).
   * Коллизия кода — ретрай с новым (uq_gift_certificates_code).
   */
  async purchase(user: AuthUser, nominalRub: number): Promise<GiftDto> {
    const problem = nominalError(nominalRub);
    if (problem) throw new BadRequestException(problem);

    for (let attempt = 0; attempt < 3; attempt++) {
      const cert = this.certs.create({
        code: generateGiftCode(),
        nominalRub,
        remainingRub: nominalRub,
        status: 'purchased',
        buyerUserId: user.id,
        expiresAt: giftExpiresAt(),
      });
      try {
        const saved = await this.certs.save(cert);
        this.logger.log(
          `Продан сертификат ${saved.code} (${saved.nominalRub} ₽) — ${user.email}`,
        );
        return toGiftDto(saved);
      } catch (err) {
        if (
          (err as { code?: string }).code !== '23505' ||
          (err as { constraint?: string }).constraint !==
            'uq_gift_certificates_code'
        ) {
          throw err;
        }
        // коллизия кода — новая попытка
      }
    }
    throw new Error('Не удалось подобрать уникальный код сертификата');
  }

  /**
   * Активация кода: одноразовая, атомарная — метка владельца ставится
   * UPDATE'ом по status='purchased' (гонку двух получателей одного кода
   * решает БД, как гонку за последний промокод). Проигравший получает
   * причину по свежепрочитанной строке.
   */
  async activate(user: AuthUser, rawCode: string): Promise<GiftDto> {
    const code = normalizeGiftCode(rawCode);
    const [rows] = await this.certs.manager.query<[{ id: string }[], number]>(
      `UPDATE gift_certificates
          SET status = 'active', activated_by_user_id = $2,
              activated_at = now(), updated_at = now()
        WHERE code = $1 AND status = 'purchased' AND expires_at > now()
        RETURNING id`,
      [code, user.id],
    );
    if (rows.length) {
      const cert = await this.certs.findOneByOrFail({ id: rows[0].id });
      this.logger.log(`Активирован сертификат ${code} — ${user.email}`);
      return toGiftDto(cert);
    }
    const cert = await this.certs.findOneBy({ code });
    throw giftActivationRefusalError(cert);
  }

  /** витрина «Подарки»: мои карты + подаренные коды + живой остаток */
  async my(user: AuthUser): Promise<GiftsMyDto> {
    const rows = await this.certs.find({
      where: [{ buyerUserId: user.id }, { activatedByUserId: user.id }],
      order: { createdAt: 'DESC' },
      take: 50,
    });
    const mine = rows.filter((c) => c.activatedByUserId === user.id);
    const given = rows.filter(
      (c) => c.status === 'purchased' && c.buyerUserId === user.id,
    );
    const live = mine.filter(
      (c) => c.status === 'active' && c.expiresAt.getTime() > Date.now(),
    );
    return {
      cards: mine.map(toGiftDto),
      given: given.map(toGiftDto),
      totals: {
        availableRub: live.reduce((sum, c) => sum + c.remainingRub, 0),
        cards: mine.length,
        given: given.length,
      },
    };
  }

  async findByCode(code: string): Promise<GiftCertificate | null> {
    return this.certs.findOneBy({ code });
  }

  /**
   * Списание в оплате брони — внутри транзакции pay (тот же EntityManager):
   * сколько снять считает giftSpendAmount (остаток карты vs остаток чека),
   * само списание — условный UPDATE по remaining_rub (гонку за последний
   * рубль решает БД). Журнал трат — строкой gift_spends. Отказ —
   * GiftRefusedError: транзакция откатывается целиком, pay спросит
   * причину по свежепрочитанной карте.
   */
  async spendInTx(
    em: EntityManager,
    args: { code: string; userId: string; bookingId: string; restRub: number },
  ): Promise<{ code: string; amount: number }> {
    const found = await em.query<
      { id: string; remaining_rub: number }[]
    >(
      `SELECT id, remaining_rub FROM gift_certificates
        WHERE code = $1 AND activated_by_user_id = $2
          AND status = 'active' AND expires_at > now()`,
      [args.code, args.userId],
    );
    if (!found.length || Number(found[0].remaining_rub) <= 0) {
      throw new GiftRefusedError(args.code, args.userId);
    }
    const amount = giftSpendAmount(Number(found[0].remaining_rub), args.restRub);
    if (amount <= 0) {
      throw new GiftRefusedError(args.code, args.userId);
    }

    const [spent] = await em.query<[{ id: string }[], number]>(
      `UPDATE gift_certificates
          SET remaining_rub = remaining_rub - $2,
              status = CASE WHEN remaining_rub - $2 <= 0
                            THEN 'exhausted' ELSE status END,
              updated_at = now()
        WHERE id = $1 AND remaining_rub >= $2
        RETURNING id`,
      [found[0].id, amount],
    );
    if (!spent.length) {
      // параллельная оплата забрала рубли между чтением и списанием
      throw new GiftRefusedError(args.code, args.userId);
    }

    await em.query(
      `INSERT INTO gift_spends (certificate_id, booking_id, user_id, amount)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (certificate_id, booking_id) DO NOTHING`,
      [found[0].id, args.bookingId, args.userId, amount],
    );
    return { code: args.code, amount };
  }

  /**
   * Возврат трат брони (отмена / провал оплаты): забирает незаполненные
   * строки журнала атомарным UPDATE по reversed_at IS NULL — повторный
   * вердикт ничего не найдёт, деньги вернутся ровно один раз. Карта
   * оживает (active), даже если была исчерпана; срок не продлевается.
   */
  async reverseForBooking(
    em: EntityManager,
    bookingId: string,
  ): Promise<number> {
    const [rows] = await em.query<
      [{ certificate_id: string; amount: number }[], number]
    >(
      `UPDATE gift_spends SET reversed_at = now()
        WHERE booking_id = $1 AND reversed_at IS NULL
        RETURNING certificate_id, amount`,
      [bookingId],
    );
    for (const row of rows) {
      await em.query(
        `UPDATE gift_certificates
            SET remaining_rub = remaining_rub + $2, status = 'active',
                updated_at = now()
          WHERE id = $1`,
        [row.certificate_id, row.amount],
      );
    }
    const returned = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    if (returned > 0) {
      this.logger.log(
        `Бронь ${bookingId}: на сертификаты возвращено ${returned} ₽`,
      );
    }
    return returned;
  }
}

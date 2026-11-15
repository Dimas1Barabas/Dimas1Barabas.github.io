import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { User } from '../users/user.entity';
import { generateReferralCode } from '../users/referral-code';
import { maskEmail, referralTotals, REFERRAL_EARNED_SQL } from './referrals.logic';
import { referralBonusFriend, referralBonusInviter } from './referral-bonuses';

/** строка списка «Пригласить»: кто пришёл по коду и дошёл ли до оплаты */
export class ReferralInvitedDto {
  @ApiProperty({ example: 'Боб' })
  name!: string;

  @ApiProperty({
    example: 'b***@example.com',
    description: 'email замаскирован: первая буква и домен',
  })
  email!: string;

  @ApiProperty({ format: 'date-time', description: 'когда зарегистрировался' })
  registeredAt!: string;

  @ApiProperty({
    example: true,
    description: 'первая бронь оплачена — бонусы начислены',
  })
  paid!: boolean;
}

/** ответ GET /referrals/my: код, размеры бонусов и статистика приглашений */
export class ReferralsMyDto {
  @ApiProperty({ example: 'AB2CD3EF', description: 'код для ссылки ?ref=' })
  code!: string;

  @ApiProperty({
    example: 300,
    description: 'бонус пригласившему за первую оплаченную бронь друга',
  })
  bonusInviter!: number;

  @ApiProperty({
    example: 100,
    description: 'welcome-бонус другу за ту же первую оплату',
  })
  bonusFriend!: number;

  @ApiProperty({ type: Object, description: 'итоги: invited / paid / earned' })
  totals!: { invited: number; paid: number; earned: number };

  @ApiProperty({
    type: [ReferralInvitedDto],
    description: 'приглашённые, свежие сверху',
  })
  invited!: ReferralInvitedDto[];
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(BonusTransaction)
    private readonly ledger: Repository<BonusTransaction>,
  ) {}

  /** страница «Пригласить»: код (лениво догенерированный) + статистика */
  async my(user: AuthUser): Promise<ReferralsMyDto> {
    const code = await this.ensureCode(user.id);
    const [invitedRows, earnedRows] = await Promise.all([
      this.users.find({
        where: { referredBy: user.id },
        order: { createdAt: 'DESC' },
        take: 50,
      }),
      this.ledger.manager.query<{ earned: string | null }[]>(
        REFERRAL_EARNED_SQL,
        [user.id],
      ),
    ]);

    const invited: ReferralInvitedDto[] = invitedRows.map((r) => ({
      name: r.name,
      email: maskEmail(r.email),
      registeredAt: r.createdAt.toISOString(),
      paid: r.referralRewardedAt !== null,
    }));
    return {
      code,
      bonusInviter: referralBonusInviter(),
      bonusFriend: referralBonusFriend(),
      totals: referralTotals(
        invited.map((i) => ({ name: i.name, email: i.email, paid: i.paid })),
        Number(earnedRows[0]?.earned ?? 0),
      ),
      invited,
    };
  }

  /**
   * Код приглашения юзера: юзеры до рефералки (и посевной админ)
   * получают его лениво при первом заходе на «Пригласить».
   * Коллизия кода — ретрай с новым (uq_users_referral_code).
   */
  private async ensureCode(userId: string): Promise<string> {
    const user = await this.users.findOneByOrFail({ id: userId });
    if (user.referralCode) return user.referralCode;

    for (let attempt = 0; attempt < 3; attempt++) {
      user.referralCode = generateReferralCode();
      try {
        // у строки уже есть id — TypeORM делает UPDATE, не INSERT
        await this.users.save(user);
        this.logger.log(`Догенерирован код приглашения для ${user.email}`);
        return user.referralCode;
      } catch (err) {
        if (
          (err as { code?: string }).code !== '23505' ||
          (err as { constraint?: string }).constraint !==
            'uq_users_referral_code'
        ) {
          throw err;
        }
        // коллизия кода — новая попытка; перед ней перечитываем строку,
        // чтобы save шёл от актуальной версии
        const fresh = await this.users.findOneByOrFail({ id: userId });
        user.referralCode = fresh.referralCode;
        if (user.referralCode) return user.referralCode;
      }
    }
    throw new Error('Не удалось подобрать уникальный код приглашения');
  }
}

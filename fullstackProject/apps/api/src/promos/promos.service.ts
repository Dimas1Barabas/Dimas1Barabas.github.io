import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { Booking } from '../bookings/booking.entity';
import { CreatePromoDto } from './dto/create-promo.dto';
import { ValidatePromoDto } from './dto/validate-promo.dto';
import {
  normalizePromoCode,
  promoDiscount,
  promoRefusalError,
} from './promo.logic';
import { Promo, PromoDto, PromoPreviewDto, toPromoDto } from './promo.entity';

/** unique_violation в Postgres */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

@Injectable()
export class PromosService {
  private readonly logger = new Logger(PromosService.name);

  constructor(
    @InjectRepository(Promo)
    private readonly promos: Repository<Promo>,
    @InjectRepository(Booking)
    private readonly bookings: Repository<Booking>,
  ) {}

  /**
   * Новый промокод. Дубль кода решает uq-констрейнт: гонке двух админов
   * нечего мериться — проигравший получает 409 promoExists.
   */
  async create(dto: CreatePromoDto): Promise<PromoDto> {
    // граница зависит от kind — это семантика, а не формат поля,
    // поэтому проверяется здесь, а не декоратором DTO
    if (dto.kind === 'percent' && dto.value > 99) {
      throw new BadRequestException('Процент скидки — не больше 99');
    }
    const expiresAt = new Date(dto.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Срок действия промокода должен быть в будущем');
    }
    const promo = this.promos.create({
      code: normalizePromoCode(dto.code),
      kind: dto.kind,
      value: dto.value,
      maxActivations: dto.maxActivations,
      usedCount: 0,
      expiresAt,
    });
    try {
      const saved = await this.promos.save(promo);
      this.logger.log(
        `Промокод ${saved.code} (${saved.kind} ${saved.value}, лимит ${saved.maxActivations}) до ${saved.expiresAt.toISOString()}`,
      );
      return toPromoDto(saved);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `Промокод ${promo.code} уже существует`,
          code: 'promoExists',
        });
      }
      throw err;
    }
  }

  /** список промокодов для админки: свежие сверху, счётчики — из БД */
  async list(): Promise<PromoDto[]> {
    const rows = await this.promos.find({ order: { createdAt: 'DESC' } });
    return rows.map((row) => toPromoDto(row));
  }

  /**
   * Превью промокода на брони — без списания активации: списание
   * происходит атомарно в момент оплаты (BookingsService.pay), поэтому
   * между превью и оплатой код могут исчерпать — тогда pay ответит 409
   * promoExhausted. Проверки зеркальны pay-ветке: своя бронь в статусе
   * PENDING_PAYMENT.
   */
  async validate(
    dto: ValidatePromoDto,
    user: AuthUser,
  ): Promise<PromoPreviewDto> {
    const booking = await this.bookings.findOneByOrFail({ id: dto.bookingId });
    if (booking.userId && booking.userId !== user.id) {
      throw new ForbiddenException('Это не ваша бронь');
    }
    if (booking.status !== 'PENDING_PAYMENT') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `Промокод применяется только к бронь, ждущей оплаты (сейчас: ${booking.status})`,
        status: booking.status,
      });
    }

    const promo = await this.promos.findOneBy({
      code: normalizePromoCode(dto.code),
    });
    if (!promo || promo.expiresAt.getTime() <= Date.now() || promo.usedCount >= promo.maxActivations) {
      // тот же источник причин, что и у оплаты — гонка решается в pay
      throw promoRefusalError(promo);
    }

    const discountRub = promoDiscount(booking.totalRub, promo.kind, promo.value);
    return {
      code: promo.code,
      kind: promo.kind,
      value: promo.value,
      discountRub,
      totalRub: booking.totalRub - discountRub,
    };
  }
}

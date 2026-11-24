import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { Booking } from '../bookings/booking.entity';
import {
  LoyaltyTier,
  loyaltyTiers,
  progressToNext,
  tierIndexForSpent,
} from './loyalty.levels';

/** перки уровня одним блоком — что получает зритель прямо сейчас */
export class LoyaltyPerksDto {
  @ApiProperty({
    example: 7,
    description: 'кэшбэк с этой покупки, %: базовый процент + прибавка уровня',
  })
  cashbackPercent!: number;

  @ApiProperty({
    example: 5,
    description: 'скидка на заказ кинобара, %',
  })
  barDiscountPercent!: number;

  @ApiProperty({
    example: false,
    description:
      'надбавки спроса Тарификатора (demand_high/full) не действуют — цена места без наценки за аншлаг',
  })
  demandMarkupWaived!: boolean;
}

/** соседняя ступень: куда расти */
export class LoyaltyNextTierDto {
  @ApiProperty({ example: 'Киноман' })
  name!: string;

  @ApiProperty({ example: 900, description: 'сколько ₽ не хватает до порога' })
  toNextRub!: number;

  @ApiProperty({
    example: 43,
    description: 'доля пути между прошлым и следующим порогом, 0..100',
  })
  progressPercent!: number;
}

/** ответ GET /loyalty/my */
export class LoyaltyStatusDto {
  @ApiProperty({ example: 'cinephile', description: 'slug уровня' })
  code!: string;

  @ApiProperty({ example: 'Киноман' })
  name!: string;

  @ApiProperty({
    example: 4300,
    description: 'пожизненные траты: SUM(total_rub) CONFIRMED-броней, ₽',
  })
  lifetimeSpentRub!: number;

  @ApiProperty({ type: LoyaltyPerksDto })
  perks!: LoyaltyPerksDto;

  @ApiProperty({
    type: LoyaltyNextTierDto,
    nullable: true,
    description: 'следующая ступень; null — уже вершина лестницы',
  })
  next!: LoyaltyNextTierDto | null;
}

/**
 * Пожизненные траты «Киномана» — один SQL для витры (репозиторий) и
 * вердиктного цикла (транзакционный EntityManager): сумма считается
 * одинаково, расползания запросов нет. SUM(int) → bigint, pg-драйвер
 * отдаёт строкой — Number() на вызывающем (урок бонусного баланса).
 */
export const LOYALTY_SPENT_SQL = `SELECT COALESCE(SUM(total_rub), 0) AS spent
  FROM bookings
 WHERE user_id = $1 AND status = 'CONFIRMED'`;

/**
 * Уровни «Киномана» (этап 38). Сумма трат считается от источника —
 * ledger-философия бонусов: возврат брони понижает её сменой статуса,
 * отдельного поля на юзере нет. Кэшбэк уровня применяется в момент
 * CONFIRMED (BookingsService.handleProcessed), скидка бара — при
 * оформлении заказа, надбавки спроса гасит Тарификатор по loyalty_tier.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    @InjectRepository(Booking)
    private readonly bookings: Repository<Booking>,
  ) {}

  /**
   * Пожизненные траты пользователя.
   */
  async lifetimeSpentRub(userId: string): Promise<number> {
    const rows = await this.bookings.query<{ spent: string | null }[]>(
      LOYALTY_SPENT_SQL,
      [userId],
    );
    return Number(rows[0]?.spent ?? 0);
  }

  /** индекс уровня пользователя (0..3) — для кэшбэка, бара и Тарификатора */
  async tierIndexOfUser(userId: string): Promise<number> {
    return tierIndexForSpent(await this.lifetimeSpentRub(userId));
  }

  /** скидка кинобара уровня пользователя, % — оформление заказа бара */
  async barDiscountPercent(userId: string): Promise<number> {
    return this.tierForSpent(await this.lifetimeSpentRub(userId))
      .barDiscountPercent;
  }

  /** личный кабинет: уровень, перки, прогресс до следующей ступени */
  async my(user: AuthUser, baseCashbackPercent: number): Promise<LoyaltyStatusDto> {
    const tiers = loyaltyTiers();
    const spent = await this.lifetimeSpentRub(user.id);
    const tier = tiers[tierIndexForSpent(spent, tiers)];
    const progress = progressToNext(spent, tiers);
    return {
      code: tier.code,
      name: tier.name,
      lifetimeSpentRub: spent,
      perks: {
        cashbackPercent: baseCashbackPercent + tier.cashbackBonusPercent,
        barDiscountPercent: tier.barDiscountPercent,
        demandMarkupWaived: tier.demandMarkupWaived,
      },
      next: progress.next
        ? {
            name: progress.next.name,
            toNextRub: progress.toNextRub,
            progressPercent: progress.progressPercent,
          }
        : null,
    };
  }

  /** уровень по уже посчитанной сумме трат — для тестов и колбэков */
  tierForSpent(spentRub: number): LoyaltyTier {
    return loyaltyTiers()[tierIndexForSpent(spentRub)];
  }
}

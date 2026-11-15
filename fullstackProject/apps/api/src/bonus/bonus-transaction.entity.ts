import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Booking } from '../bookings/booking.entity';
import { User } from '../users/user.entity';

/** направления записей: accrual — начисление (+ к балансу), spend — списание (−) */
export const BONUS_KINDS = ['accrual', 'spend'] as const;
export type BonusKind = (typeof BONUS_KINDS)[number];

/**
 * Причины движений — почему изменился баланс. Тройка
 * (booking_id, reason, user_id) уникальна: одна операция одного типа
 * по бронь для конкретного счёта не задваивается, ределивери событий
 * воркера упирается в констрейнт. Реферальная программа завела по одной
 * брони записи двух счётов (другу и пригласившему) — поэтому уника
 * расширена с пары (booking_id, reason) тройкой с user_id.
 */
export const BONUS_REASONS = [
  /** accrual: кэшбэк по CONFIRMED-брони */
  'cashback',
  /** spend: списание при оплате брони */
  'payment',
  /** accrual: возврат списанного — оплата не прошла (FAILED) */
  'payment_failed',
  /** accrual: возврат списанного при отмене брони (CANCELLED) */
  'refund',
  /** spend: гашение кэшбэка при отмене брони — но не в минус */
  'clawback',
  /** accrual: награда пригласившему за первую оплаченную бронь друга */
  'referral',
  /** accrual: welcome-бонус другу за ту же первую оплату */
  'referral_welcome',
] as const;
export type BonusReason = (typeof BONUS_REASONS)[number];

/**
 * Бонусный счёт — ledger «как деньги»: записи только добавляются,
 * баланс нигде не хранится, а считается от источника
 * (SUM(accrual) − SUM(spend) по user_id). Курс 1 бонус = 1 ₽.
 */
@Entity('bonus_transactions')
@Unique('uq_bonus_booking_reason_user', ['bookingId', 'reason', 'userId'])
export class BonusTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** бронь-источник движения (кэшбэк / списание / возвраты) */
  @Column({ name: 'booking_id' })
  bookingId: string;

  @ManyToOne(() => Booking, { nullable: false })
  @JoinColumn({ name: 'booking_id' })
  booking: Booking;

  @Column({ length: 16 })
  kind: BonusKind;

  @Column({ length: 16 })
  reason: BonusReason;

  /** сколько бонусов (положительное целое; направление — в kind) */
  @Column({ type: 'int' })
  amount: number;

  /** ledger неизменяем — updated_at не нужен */
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответов */
export class BonusTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: BONUS_KINDS, description: 'accrual — начисление, spend — списание' })
  kind!: BonusKind;

  @ApiProperty({
    enum: BONUS_REASONS,
    description:
      'почему: cashback / payment / payment_failed / refund / clawback / referral / referral_welcome',
  })
  reason!: BonusReason;

  @ApiProperty({ example: 50, description: 'сколько бонусов (направление — в kind)' })
  amount!: number;

  @ApiProperty({ format: 'uuid', description: 'бронь-источник движения' })
  bookingId!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export function toBonusTransactionDto(
  row: BonusTransaction,
): BonusTransactionDto {
  return {
    id: row.id,
    kind: row.kind,
    reason: row.reason,
    amount: row.amount,
    bookingId: row.bookingId,
    createdAt: row.createdAt.toISOString(),
  };
}

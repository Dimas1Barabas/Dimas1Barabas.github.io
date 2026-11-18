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
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';

/**
 * Жизненный цикл карты: purchased (куплена, код ещё не активирован) →
 * active (получатель активировал код, можно тратить) → exhausted
 * (remaining_rub = 0). Возврат отменённой брони возвращает деньги и
 * оживляет exhausted → active; истечение (expires_at) проверяется
 * на лету при активации и трате — отдельного статуса нет.
 */
export const GIFT_STATUSES = ['purchased', 'active', 'exhausted'] as const;
export type GiftStatus = (typeof GIFT_STATUSES)[number];

/**
 * Гифт-сертификат: номинал покупается на кассе сайта, получатель
 * активирует код (один раз, атомарным UPDATE по status='purchased') и
 * тратит частями — списание в BookingsService.pay условным UPDATE по
 * remaining_rub, как активация промокода и остатки кинобара.
 */
@Entity('gift_certificates')
@Unique('uq_gift_certificates_code', ['code'])
export class GiftCertificate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** «GIFT-XXXXXXXX» — нормализуется в верхний регистр (normalizeGiftCode) */
  @Column({ length: 16 })
  code: string;

  @Column({ name: 'nominal_rub', type: 'int' })
  nominalRub: number;

  /** сколько ещё можно потратить; убывает только атомарным UPDATE */
  @Column({ name: 'remaining_rub', type: 'int' })
  remainingRub: number;

  @Column({ length: 12 })
  status: GiftStatus;

  /** кто купил карту (кому показать выданные коды) */
  @Index('idx_gift_certificates_buyer')
  @Column({ name: 'buyer_user_id', type: 'uuid' })
  buyerUserId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'buyer_user_id' })
  buyerUser: User;

  /** кто активировал код — владелец баланса карты (один раз навсегда) */
  @Index('idx_gift_certificates_activated_by')
  @Column({ name: 'activated_by_user_id', type: 'uuid', nullable: true })
  activatedByUserId: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'activated_by_user_id' })
  activatedByUser: User | null;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответов */
export class GiftDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'GIFT-AB2CD3EF' })
  code!: string;

  @ApiProperty({ example: 2000, description: 'номинал при покупке, ₽' })
  nominalRub!: number;

  @ApiProperty({ example: 1500, description: 'остаток, ₽' })
  remainingRub!: number;

  @ApiProperty({
    enum: GIFT_STATUSES,
    description: 'purchased — ждёт активации, active — можно тратить, exhausted — потрачен',
  })
  status!: GiftStatus;

  @ApiProperty({ format: 'date-time', description: 'когда получатель активировал код' })
  activatedAt!: string | null;

  @ApiProperty({ format: 'date-time', description: 'срок: после него тратить и активировать нельзя' })
  expiresAt!: string;

  @ApiProperty({ format: 'date-time', description: 'момент покупки' })
  createdAt!: string;
}

export function toGiftDto(row: GiftCertificate): GiftDto {
  return {
    id: row.id,
    code: row.code,
    nominalRub: row.nominalRub,
    remainingRub: row.remainingRub,
    status: row.status,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

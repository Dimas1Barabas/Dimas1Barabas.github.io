import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/** виды скидки — один источник для типа, DTO и логики */
export const PROMO_KINDS = ['percent', 'fixed'] as const;

export type PromoKind = (typeof PROMO_KINDS)[number];

/**
 * Промокод: админ задаёт вид скидки (процент или фикс в рублях), лимит
 * активаций и срок. Активация списывается атомарно в момент оплаты
 * (см. BookingsService.pay): `UPDATE ... SET used_count = used_count + 1
 * WHERE used_count < max_activations` — гонку за последний код решает БД.
 */
@Entity('promos')
@Unique('uq_promos_code', ['code'])
export class Promo {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** нормализуется в верхний регистр (normalizePromoCode) */
  @Column({ length: 32 })
  code: string;

  @Column({ length: 8 })
  kind: PromoKind;

  /** проценты (1–99) или рубли — по kind */
  @Column({ type: 'int' })
  value: number;

  @Column({ name: 'max_activations', type: 'int' })
  maxActivations: number;

  @Column({ name: 'used_count', type: 'int', default: 0 })
  usedCount: number;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответов */
export class PromoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'CINE10' })
  code!: string;

  @ApiProperty({ enum: PROMO_KINDS, description: 'вид скидки' })
  kind!: PromoKind;

  @ApiProperty({ example: 10, description: 'проценты или рубли — по kind' })
  value!: number;

  @ApiProperty({ example: 100, description: 'лимит активаций' })
  maxActivations!: number;

  @ApiProperty({ example: 3, description: 'уже использованные активации' })
  usedCount!: number;

  @ApiProperty({ format: 'date-time', description: 'срок действия' })
  expiresAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export function toPromoDto(promo: Promo): PromoDto {
  return {
    id: promo.id,
    code: promo.code,
    kind: promo.kind,
    value: promo.value,
    maxActivations: promo.maxActivations,
    usedCount: promo.usedCount,
    expiresAt: promo.expiresAt.toISOString(),
    createdAt: promo.createdAt.toISOString(),
  };
}

/** превью промокода на конкретной брони — ответ POST /promos/validate */
export class PromoPreviewDto {
  @ApiProperty({ example: 'CINE10' })
  code!: string;

  @ApiProperty({ enum: PROMO_KINDS })
  kind!: PromoKind;

  @ApiProperty({ example: 10 })
  value!: number;

  @ApiProperty({ example: 100, description: 'скидка, ₽' })
  discountRub!: number;

  @ApiProperty({ example: 900, description: 'итог после скидки, ₽' })
  totalRub!: number;
}

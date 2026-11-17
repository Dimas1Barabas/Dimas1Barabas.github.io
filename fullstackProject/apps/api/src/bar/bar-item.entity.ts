import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  UpdateDateColumn,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/** категории витрины кинобара — один источник для типа, DTO и посева */
export const BAR_CATEGORIES = ['popcorn', 'drinks', 'snacks', 'combo'] as const;

export type BarCategory = (typeof BAR_CATEGORIES)[number];

/**
 * Позиция каталога кинобара с остатком порций. Списание — атомарный
 * UPDATE … WHERE stock >= qty в транзакции заказа (см. BarService.create);
 * отмена заказа возвращает порции тем же инкрементом. stock = 0 —
 * «продано», позиция остаётся на витрине, заказ возвращает 409.
 */
@Entity('bar_items')
@Unique('uq_bar_items_slug', ['slug'])
export class BarItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** стабильный ключ посева/фронта, напр. 'popcorn-salted' */
  @Column({ length: 32 })
  slug: string;

  @Column({ length: 64 })
  name: string;

  @Column({ length: 16 })
  category: BarCategory;

  @Column({ name: 'price_rub' })
  priceRub: number;

  @Column()
  stock: number;

  /** снята с продажи, но видна истории заказов (снимки имени) */
  @Column({ default: true })
  active: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** строка витрины GET /bar/menu */
export class BarItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'popcorn-salted' })
  slug!: string;

  @ApiProperty({ example: 'Попкорн солёный' })
  name!: string;

  @ApiProperty({ enum: BAR_CATEGORIES })
  category!: BarCategory;

  @ApiProperty({ example: 320, description: 'цена, ₽' })
  priceRub!: number;

  @ApiProperty({
    example: 24,
    description: 'порций на складе; 0 — продано',
  })
  stock!: number;

  @ApiProperty({ example: false, description: 'true — продано (stock = 0)' })
  soldOut!: boolean;
}

export function toBarItemDto(item: BarItem): BarItemDto {
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    category: item.category,
    priceRub: item.priceRub,
    stock: item.stock,
    soldOut: item.stock <= 0,
  };
}

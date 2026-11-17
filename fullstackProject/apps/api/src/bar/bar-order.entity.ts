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
import { Session } from '../movies/session.entity';
import { User } from '../users/user.entity';
import { BarItem } from './bar-item.entity';

/**
 * Статусы заказа кинобара. NEW создаёт API; переходы дальше гоняет
 * Бармен (кнопки «в работу» / «готов» / «выдан» на экране бара),
 * API слушает bar.order.status и отражает их здесь. Отмена — только
 * на NEW/PREPARING (еда ещё не выдана), инициирует владелец через API:
 * остатки возвращаются на склад, Бармен убирает заказ из очереди.
 */
export const BAR_ORDER_STATUSES = [
  'NEW',
  'PREPARING',
  'READY',
  'PICKED_UP',
  'CANCELLED',
] as const;

export type BarOrderStatus = (typeof BAR_ORDER_STATUSES)[number];

/** заказ можно отменить, пока Бармен не выдал его */
export const BAR_CANCELLABLE: readonly BarOrderStatus[] = ['NEW', 'PREPARING'];

/** заказ «живой» — не выдан и не отменён (для витрины «мои заказы») */
export const BAR_ACTIVE: readonly BarOrderStatus[] = [
  'NEW',
  'PREPARING',
  'READY',
];

/**
 * Заказ кинобара: предзаказ с оплатой на кассе при получении.
 * sessionId необязателен — подсказка Бармену «выдать к сеансу 19:30»
 * и контекст на экране бара. total_rub — сумма позиций по снимкам цен.
 */
@Entity('bar_orders')
@Index('idx_bar_orders_user', ['userId'])
export class BarOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** «выдать к сеансу»; null — просто забрать на стойке бара */
  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId: string | null;

  @ManyToOne(() => Session, { nullable: true })
  @JoinColumn({ name: 'session_id' })
  session: Session | null;

  @Column({ length: 16 })
  status: BarOrderStatus;

  @Column({ name: 'total_rub' })
  totalRub: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /** позиции заказа (снимки имени/цены на момент оформления) */
  items?: BarOrderItem[];
}

/**
 * Позиция заказа — снимок каталога: имя и цена фиксируются при
 * оформлении, дальнейшие правки прайса состав заказа не меняют.
 */
@Entity('bar_order_items')
@Unique('uq_bar_order_item', ['orderId', 'itemId'])
export class BarOrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id' })
  orderId: string;

  @ManyToOne(() => BarOrder, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: BarOrder;

  @Column({ name: 'item_id' })
  itemId: string;

  @ManyToOne(() => BarItem, { nullable: false })
  @JoinColumn({ name: 'item_id' })
  item: BarItem;

  /** снимок имени позиции на момент оформления */
  @Column({ length: 64 })
  name: string;

  /** снимок цены на момент оформления */
  @Column({ name: 'price_rub' })
  priceRub: number;

  @Column()
  qty: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

/** позиция в DTO заказа */
export class BarOrderItemDto {
  @ApiProperty({ format: 'uuid' })
  itemId!: string;

  @ApiProperty({ example: 'Попкорн карамельный' })
  name!: string;

  @ApiProperty({ example: 340 })
  priceRub!: number;

  @ApiProperty({ example: 2 })
  qty!: number;
}

/** заказ в «Моих заказах» и ответе оформления */
export class BarOrderDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: BAR_ORDER_STATUSES,
    description:
      'NEW — оформлен, PREPARING — Бармен готовит, READY — ждать на ' +
      'стойке, PICKED_UP — выдан, CANCELLED — отменён',
  })
  status!: BarOrderStatus;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  sessionId!: string | null;

  @ApiProperty({ example: 1180, description: 'сумма позиций, ₽' })
  totalRub!: number;

  @ApiProperty({ type: [BarOrderItemDto] })
  items!: BarOrderItemDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export function toBarOrderDto(
  order: BarOrder,
  items: BarOrderItem[],
): BarOrderDto {
  return {
    id: order.id,
    status: order.status,
    sessionId: order.sessionId,
    totalRub: order.totalRub,
    items: items.map((i) => ({
      itemId: i.itemId,
      name: i.name,
      priceRub: i.priceRub,
      qty: i.qty,
    })),
    createdAt: order.createdAt.toISOString(),
  };
}

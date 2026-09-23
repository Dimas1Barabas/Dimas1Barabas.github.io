import { ApiProperty } from '@nestjs/swagger';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';

/** значения lifecycle-статусов — один источник для типа, DTO и аналитики */
export const BOOKING_STATUSES = [
  'PENDING_PAYMENT',
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLING',
  'CANCELLED',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'movie_id' })
  movieId: string;

  @ManyToOne(() => Movie, { nullable: false })
  @JoinColumn({ name: 'movie_id' })
  movie: Movie;

  /** сеанс, на который куплены места (фильм + зал + время) */
  @Column({ name: 'session_id' })
  sessionId: string;

  @ManyToOne(() => Session, { nullable: false })
  @JoinColumn({ name: 'session_id' })
  session: Session;

  @Column({ name: 'customer_name', length: 60 })
  customerName: string;

  /** владелец брони (из JWT); null — брони, созданные до авторизации */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** конкретные места: коды «ряд-место», например ["5-7", "5-8"] */
  @Column({ type: 'jsonb' })
  seats: string[];

  @Column({ name: 'total_rub', type: 'int' })
  totalRub: number;

  /** промокод, применённый при оплате (активация списывается в pay) */
  @Column({ name: 'promo_code', length: 32, nullable: true })
  promoCode: string | null;

  /** скидка применённого промокода, ₽ (null — бронь без промокода) */
  @Column({ name: 'discount_rub', type: 'int', nullable: true })
  discountRub: number | null;

  /** сколько бонусов вчёно в оплату (списание в pay; null — без бонусов) */
  @Column({ name: 'bonus_spent', type: 'int', nullable: true })
  bonusSpent: number | null;

  /** lifecycle: ждёт оплаты → проводится → вердикт; не оплачена вовремя — истекла */
  @Column({ length: 24, default: 'PENDING_PAYMENT' })
  status: BookingStatus;

  /** дедлайн оплаты (актуален для PENDING_PAYMENT) */
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  /** сообщение от Go-воркера (детали оплаты или возврата) */
  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ name: 'processed_by', type: 'varchar', length: 64, nullable: true })
  processedBy: string | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответов */
export class BookingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  movieId!: string;

  @ApiProperty({ example: 'Дюна: Часть три' })
  movieTitle!: string;

  @ApiProperty({ example: 24, description: 'оттенок постера фильма' })
  movieHue!: number;

  @ApiProperty({ example: '🏜️' })
  movieGenreIcon!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ format: 'date-time' })
  sessionAt!: string;

  @ApiProperty({ example: 'IMAX' })
  hall!: string;

  @ApiProperty({ example: 'Алиса' })
  customerName!: string;

  /** null — брони, созданные до появления авторизации */
  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  userId!: string | null;

  @ApiProperty({ example: ['5-7', '5-8'], description: 'коды «ряд-место»' })
  seats!: string[];

  @ApiProperty({ example: 1000, description: 'итого, ₽ (после скидки, если есть)' })
  totalRub!: number;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'CINE10',
    description: 'промокод, применённый при оплате',
  })
  promoCode!: string | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    example: 100,
    description: 'скидка по промокоду, ₽',
  })
  discountRub!: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    example: 250,
    description: 'сколько бонусов списано при оплате',
  })
  bonusSpent!: number | null;

  /** union-тип в reflect-metadata неразличим — перечисляем явно */
  @ApiProperty({
    enum: BOOKING_STATUSES,
    description: 'lifecycle брони: резерв → оплата → вердикт воркера',
  })
  status!: BookingStatus;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'дедлайн оплаты (актуален для PENDING_PAYMENT)',
  })
  expiresAt!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'вердикт Go-воркера' })
  message!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'ticket-worker-1' })
  processedBy!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  processedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export function toBookingDto(
  booking: Booking,
  movie?: Movie,
  session?: Session,
): BookingDto {
  const m = movie ?? booking.movie;
  const s = session ?? booking.session;
  return {
    id: booking.id,
    movieId: booking.movieId,
    movieTitle: m?.title ?? '—',
    movieHue: m?.hue ?? 220,
    movieGenreIcon: m?.genreIcon ?? '🎟️',
    sessionId: booking.sessionId,
    sessionAt: s?.startsAt.toISOString() ?? '—',
    hall: s?.hall ?? '—',
    customerName: booking.customerName,
    userId: booking.userId ?? null,
    seats: booking.seats,
    totalRub: booking.totalRub,
    promoCode: booking.promoCode ?? null,
    discountRub: booking.discountRub ?? null,
    bonusSpent: booking.bonusSpent ?? null,
    status: booking.status,
    expiresAt: booking.expiresAt?.toISOString() ?? null,
    message: booking.message,
    processedBy: booking.processedBy,
    processedAt: booking.processedAt?.toISOString() ?? null,
    createdAt: booking.createdAt.toISOString(),
  };
}

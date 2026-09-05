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

export type BookingStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED';

@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'movie_id' })
  movieId: string;

  @ManyToOne(() => Movie, { nullable: false })
  @JoinColumn({ name: 'movie_id' })
  movie: Movie;

  @Column({ name: 'customer_name', length: 60 })
  customerName: string;

  /** конкретные места: коды «ряд-место», например ["5-7", "5-8"] */
  @Column({ type: 'jsonb' })
  seats: string[];

  @Column({ name: 'total_rub', type: 'int' })
  totalRub: number;

  @Column({ length: 16, default: 'PENDING' })
  status: BookingStatus;

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

export interface BookingDto {
  id: string;
  movieId: string;
  movieTitle: string;
  movieHue: number;
  movieGenreIcon: string;
  customerName: string;
  seats: string[];
  totalRub: number;
  status: BookingStatus;
  message: string | null;
  processedBy: string | null;
  processedAt: string | null;
  createdAt: string;
}

export function toBookingDto(booking: Booking, movie?: Movie): BookingDto {
  const m = movie ?? booking.movie;
  return {
    id: booking.id,
    movieId: booking.movieId,
    movieTitle: m?.title ?? '—',
    movieHue: m?.hue ?? 220,
    movieGenreIcon: m?.genreIcon ?? '🎟️',
    customerName: booking.customerName,
    seats: booking.seats,
    totalRub: booking.totalRub,
    status: booking.status,
    message: booking.message,
    processedBy: booking.processedBy,
    processedAt: booking.processedAt?.toISOString() ?? null,
    createdAt: booking.createdAt.toISOString(),
  };
}

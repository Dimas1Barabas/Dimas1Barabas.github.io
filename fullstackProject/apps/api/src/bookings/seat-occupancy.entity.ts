import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Занятость мест: одна строка = одно место одного сеанса.
 * Составной уникальный констрейнт (session_id, seat) — единственный арбитр
 * в гонке за одно место: вторая транзакция получает 23505 и откатывается.
 * Одно и то же место в разных сеансах одного фильма — разные строки.
 */
@Entity('seat_occupancy')
@Unique('uq_session_seat', ['sessionId', 'seat'])
export class SeatOccupancy {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'session_id' })
  sessionId: string;

  /** код места «ряд-место», например «5-7» */
  @Column({ length: 8 })
  seat: string;

  @Index()
  @Column({ name: 'booking_id' })
  bookingId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

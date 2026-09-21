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

/** статусы записи в листе ожидания — один источник для типа, DTO и логики */
export const WAITLIST_STATUSES = ['WAITING', 'NOTIFIED', 'LEFT'] as const;

export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

/**
 * Лист ожидания сеанса: встают, когда зал полный (409 seatsTaken или
 * free === 0). Один пользователь — одна запись на сеанс (uq по паре
 * session_id + user_id, арбитр дубля как у отзывов).
 *
 * Позиция в очереди — порядок по queued_at среди WAITING. При освобождении
 * места уведомляется только голова очереди, место НЕ резервируется —
 * честная гонка: кто успел забронировать, тот успел. NOTIFIED-запись
 * снова встать в очередь может — но в конец (queued_at обновляется).
 */
@Entity('waitlist_entries')
@Unique('uq_waitlist_session_user', ['sessionId', 'userId'])
export class WaitlistEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'session_id' })
  sessionId: string;

  @ManyToOne(() => Session, { nullable: false })
  @JoinColumn({ name: 'session_id' })
  session: Session;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ length: 16 })
  status: WaitlistStatus;

  /** позиция в очереди считается по этому времени; обновляется при повторном входе */
  @Column({ name: 'queued_at', type: 'timestamptz' })
  queuedAt: Date;

  /** когда голове очереди сообщили об освободившемся месте */
  @Column({ name: 'notified_at', type: 'timestamptz', nullable: true })
  notifiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответов */
export class WaitlistEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ enum: WAITLIST_STATUSES, description: 'WAITING — в очереди, NOTIFIED — уже получил уведомление, LEFT — вышел' })
  status!: WaitlistStatus;

  /** позиция среди WAITING (1 — голова); null, если запись уже не в очереди */
  @ApiProperty({ example: 2, nullable: true, description: 'позиция в очереди' })
  position!: number | null;

  @ApiProperty({ format: 'date-time' })
  queuedAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  notifiedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export function toWaitlistEntryDto(
  entry: WaitlistEntry,
  position: number | null = null,
): WaitlistEntryDto {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    userId: entry.userId,
    status: entry.status,
    position,
    queuedAt: entry.queuedAt.toISOString(),
    notifiedAt: entry.notifiedAt ? entry.notifiedAt.toISOString() : null,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** запись + контекст сеанса для «Моих листов ожидания» (GET /waitlist/my) */
export class WaitlistMyEntryDto extends WaitlistEntryDto {
  @ApiProperty({ format: 'uuid' })
  movieId!: string;

  @ApiProperty({ example: 'Дюна: Часть третья' })
  movieTitle!: string;

  @ApiProperty({ example: 'IMAX' })
  hall!: string;

  @ApiProperty({ format: 'date-time', description: 'начало сеанса' })
  startsAt!: string;
}

export function toWaitlistMyDto(
  entry: WaitlistEntry,
  position: number | null = null,
): WaitlistMyEntryDto {
  return {
    ...toWaitlistEntryDto(entry, position),
    movieId: entry.session?.movieId ?? '',
    movieTitle: entry.session?.movie?.title ?? '—',
    hall: entry.session?.hall ?? '—',
    startsAt: entry.session?.startsAt?.toISOString() ?? '',
  };
}

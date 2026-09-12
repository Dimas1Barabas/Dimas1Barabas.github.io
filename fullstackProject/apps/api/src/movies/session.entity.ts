import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Movie } from './movie.entity';

/**
 * Сеанс фильма: зал + время. У фильма их много — бронь и занятость мест
 * привязаны к сеансу, а не к фильму (uq(session_id, seat) в seat_occupancy).
 */
@Entity('sessions')
export class Session {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'movie_id' })
  movieId: string;

  @ManyToOne(() => Movie, (movie) => movie.sessions, { nullable: false })
  @JoinColumn({ name: 'movie_id' })
  movie: Movie;

  /** название зала — подпись в UI («Красный», «IMAX»); геометрия общая */
  @Column({ length: 40 })
  hall: string;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

export interface SessionDto {
  id: string;
  hall: string;
  startsAt: string;
}

export function toSessionDto(session: Session): SessionDto {
  return {
    id: session.id,
    hall: session.hall,
    startsAt: session.startsAt.toISOString(),
  };
}

/** DTO сеансов, отсортированные по времени — чистая функция для тестов */
export function toSessionDtos(
  sessions: Session[] | undefined,
): SessionDto[] {
  return [...(sessions ?? [])]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map(toSessionDto);
}

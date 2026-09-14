import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Session, SessionDto, toSessionDtos } from './session.entity';

@Entity('movies')
export class Movie {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  title: string;

  @Column()
  description: string;

  @Column()
  genre: string;

  /** emoji-иконка жанра для «постера» на фронтенде */
  @Column({ name: 'genre_icon' })
  genreIcon: string;

  @Column({ name: 'duration_min', type: 'smallint' })
  durationMin: number;

  @Column({ name: 'price_rub', type: 'smallint' })
  priceRub: number;

  /** базовый оттенок градиентного постера (HSL hue) */
  @Column({ type: 'smallint' })
  hue: number;

  /** сеансы фильма: зал + время; cascade — создание/посев одним save */
  @OneToMany(() => Session, (session) => session.movie, {
    cascade: true,
  })
  sessions: Session[];

  /** средняя оценка отзывов (денормализована, пересчитывается в tx отзыва) */
  @Column({ name: 'rating_avg', type: 'double precision', default: 0 })
  ratingAvg: number;

  @Column({ name: 'rating_count', type: 'int', default: 0 })
  ratingCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

export interface MovieDto {
  id: string;
  title: string;
  description: string;
  genre: string;
  genreIcon: string;
  durationMin: number;
  priceRub: number;
  hue: number;
  /** средняя оценка и число отзывов (нет отзывов — нули) */
  ratingAvg: number;
  ratingCount: number;
  /** отсортированы по startsAt */
  sessions: SessionDto[];
}

export function toMovieDto(movie: Movie): MovieDto {
  return {
    id: movie.id,
    title: movie.title,
    description: movie.description,
    genre: movie.genre,
    genreIcon: movie.genreIcon,
    durationMin: movie.durationMin,
    priceRub: movie.priceRub,
    hue: movie.hue,
    // только что созданный фильм ещё не имеет агрегатов
    ratingAvg: movie.ratingAvg ?? 0,
    ratingCount: movie.ratingCount ?? 0,
    sessions: toSessionDtos(movie.sessions),
  };
}

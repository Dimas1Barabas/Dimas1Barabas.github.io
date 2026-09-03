import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

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

  @Column({ name: 'session_at', type: 'timestamptz' })
  sessionAt: Date;

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
  sessionAt: string;
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
    sessionAt: movie.sessionAt.toISOString(),
  };
}

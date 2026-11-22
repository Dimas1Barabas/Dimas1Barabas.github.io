import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Внешние метаданные фильма (этап 37): результат синка с кино-справочником.
 * PK = id фильма из каталога (1:1), FK с ON DELETE CASCADE — в миграции:
 * фильм удалили, внешняя строка не должна переживать каталог.
 *
 * Это витринная читаемая модель, а не источник правды: строки нет — карточка
 * фильма живёт как жила, без внешнего блока.
 */
@Entity('external_movies')
export class ExternalMovie {
  /** id фильма из каталога */
  @PrimaryColumn({ name: 'movie_id', type: 'uuid' })
  movieId: string;

  /** рейтинг провайдера по его шкале (0..10); 0 — рейтинга нет */
  @Column({ type: 'real' })
  rating: number;

  @Column({ type: 'int' })
  votes: number;

  @Column({ type: 'int' })
  year: number;

  /** simple-array: csv в text-колонке */
  @Column({ type: 'simple-array' })
  genres: string[];

  @Column()
  country: string;

  @Column()
  director: string;

  @Column({ type: 'simple-array' })
  actors: string[];

  @Column({ name: 'age_rating' })
  ageRating: string;

  @Column({ name: 'trailer_url' })
  trailerUrl: string;

  /** постер у провайдера: перезалить в S3 можно и позже */
  @Column({ name: 'source_poster_url' })
  sourcePosterUrl: string;

  /** время последнего успешного синка */
  @Column({ name: 'synced_at', type: 'timestamptz' })
  syncedAt: Date;
}

/** внешний блок MovieDto: появляется у карточки после синка */
export class ExternalMovieInfoDto {
  @ApiProperty({ example: 8.3, description: 'рейтинг справочника (0..10)' })
  rating!: number;

  @ApiProperty({ example: 120450, description: 'сколько оценок за рейтингом' })
  votes!: number;

  @ApiProperty({ example: 2025 })
  year!: number;

  @ApiProperty({ example: ['фантастика', 'драма'] })
  genres!: string[];

  @ApiProperty({ example: 'Россия' })
  country!: string;

  @ApiProperty({ example: 'Дени Вильнёв' })
  director!: string;

  @ApiProperty({ example: ['Тимоти Шаламе', 'Зендея'] })
  actors!: string[];

  @ApiProperty({ example: '16+' })
  ageRating!: string;

  @ApiProperty({ example: 'https://trailers.example/milky-way' })
  trailerUrl!: string;

  @ApiProperty({
    example: '2026-11-22T10:00:00.000Z',
    description: 'время последнего успешного синка',
  })
  syncedAt!: string;
}

export function toExternalInfoDto(row: ExternalMovie): ExternalMovieInfoDto {
  return {
    rating: row.rating ?? 0,
    votes: row.votes ?? 0,
    year: row.year ?? 0,
    genres: row.genres ?? [],
    country: row.country ?? '',
    director: row.director ?? '',
    actors: row.actors ?? [],
    ageRating: row.ageRating ?? '',
    trailerUrl: row.trailerUrl ?? '',
    syncedAt: (row.syncedAt ?? new Date(0)).toISOString(),
  };
}

import {
  IsDateString,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** новые сеансы добавляет администратор: POST /api/movies */
export class CreateMovieDto {
  @IsString()
  @MinLength(1, { message: 'Название пустое' })
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  genre!: string;

  /** emoji-иконка жанра для «постера» */
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  genreIcon!: string;

  @IsInt()
  @Min(10, { message: 'Коротко даже для мультфильма' })
  @Max(300)
  durationMin!: number;

  @IsInt()
  @Min(0)
  @Max(100_000)
  priceRub!: number;

  /** базовый оттенок градиентного постера (HSL hue) */
  @IsInt()
  @Min(0)
  @Max(360)
  hue!: number;

  @IsDateString()
  sessionAt!: string;
}

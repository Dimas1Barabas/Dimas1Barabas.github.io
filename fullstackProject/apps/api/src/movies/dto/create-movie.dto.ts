import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CreateSessionDto } from './create-session.dto';

/** новые фильмы добавляет администратор: POST /api/movies — сразу с сеансами */
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

  /** @Type обязателен: без него nested-объекты не валидируются (whitelist их выкинет) */
  @IsArray()
  @ArrayMinSize(1, { message: 'Хотя бы один сеанс' })
  @ValidateNested({ each: true })
  @Type(() => CreateSessionDto)
  sessions!: CreateSessionDto[];
}

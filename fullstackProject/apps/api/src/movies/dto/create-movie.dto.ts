import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({ example: 'Дюна: Часть три', maxLength: 120 })
  @IsString()
  @MinLength(1, { message: 'Название пустое' })
  @MaxLength(120)
  title!: string;

  @ApiProperty({ example: 'Продолжение пустынной саги', maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @ApiProperty({ example: 'фантастика', maxLength: 40 })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  genre!: string;

  /** emoji-иконка жанра для «постера» */
  @ApiProperty({ example: '🏜️', maxLength: 8 })
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  genreIcon!: string;

  @ApiProperty({ example: 155, minimum: 10, maximum: 300, description: 'минуты' })
  @IsInt()
  @Min(10, { message: 'Коротко даже для мультфильма' })
  @Max(300)
  durationMin!: number;

  @ApiProperty({ example: 500, minimum: 0, description: 'цена билета, ₽' })
  @IsInt()
  @Min(0)
  @Max(100_000)
  priceRub!: number;

  /** базовый оттенок градиентного постера (HSL hue) */
  @ApiProperty({ example: 24, minimum: 0, maximum: 360 })
  @IsInt()
  @Min(0)
  @Max(360)
  hue!: number;

  /** @Type обязателен: без него nested-объекты не валидируются (whitelist их выкинет) */
  @ApiProperty({ type: [CreateSessionDto], minItems: 1 })
  @IsArray()
  @ArrayMinSize(1, { message: 'Хотя бы один сеанс' })
  @ValidateNested({ each: true })
  @Type(() => CreateSessionDto)
  sessions!: CreateSessionDto[];
}

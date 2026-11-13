import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** подсказки витрины: GET /api/search/movies?q=…&limit=8 */
export class SearchQueryDto {
  @ApiProperty({
    example: 'рекурс',
    description: 'Поисковая фраза: совпадения в названии, описании, жанре',
    maxLength: 100,
  })
  @IsString()
  @MinLength(1, { message: 'Пустой запрос' })
  @MaxLength(100)
  q!: string;

  @ApiPropertyOptional({
    example: 8,
    minimum: 1,
    maximum: 20,
    default: 8,
    description: 'Сколько подсказок вернуть',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

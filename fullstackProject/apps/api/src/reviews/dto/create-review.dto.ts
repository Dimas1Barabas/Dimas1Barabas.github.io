import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateReviewDto {
  /** оценка «звёздами»; право на отзыв проверяет сервис по брони */
  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @IsInt({ message: 'Оценка — целое число от 1 до 5' })
  @Min(1, { message: 'Оценка — целое число от 1 до 5' })
  @Max(5, { message: 'Оценка — целое число от 1 до 5' })
  rating!: number;

  @ApiProperty({
    example: 'Смотрел в IMAX — звук и картинка на высоте',
    minLength: 10,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(10, { message: 'Отзыв слишком короткий — минимум 10 символов' })
  @MaxLength(1000, { message: 'Отзыв — до 1000 символов' })
  text!: string;
}

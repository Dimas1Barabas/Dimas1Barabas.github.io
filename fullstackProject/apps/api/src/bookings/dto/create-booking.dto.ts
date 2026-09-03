import { Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateBookingDto {
  @IsUUID()
  movieId!: string;

  @IsString()
  @MinLength(2, { message: 'Имя слишком короткое' })
  @MaxLength(60)
  customerName!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(8, { message: 'Максимум 8 мест за один заказ' })
  seats!: number;
}

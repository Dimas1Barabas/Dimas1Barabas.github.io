import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBookingDto {
  @IsUUID()
  movieId!: string;

  @IsString()
  @MinLength(2, { message: 'Имя слишком короткое' })
  @MaxLength(60)
  customerName!: string;

  /** коды мест «ряд-место»; принадлежность залу проверяет сервис */
  @IsArray()
  @ArrayMinSize(1, { message: 'Выберите хотя бы одно место' })
  @ArrayMaxSize(8, { message: 'Максимум 8 мест за один заказ' })
  @IsString({ each: true })
  @Matches(/^\d+-\d+$/, {
    each: true,
    message: 'Код места — «ряд-место», например 5-7',
  })
  seats!: string[];
}

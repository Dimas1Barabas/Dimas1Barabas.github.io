import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBookingDto {
  /** бронь привязана к сеансу; фильм выводится из сеанса на сервере */
  @ApiProperty({ format: 'uuid', description: 'сеанс из каталога /api/movies' })
  @IsUUID()
  sessionId!: string;

  /** не указано — берём имя из JWT авторизованного пользователя */
  @ApiProperty({
    required: false,
    example: 'Алиса',
    minLength: 2,
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Имя слишком короткое' })
  @MaxLength(60)
  customerName?: string;

  /** коды мест «ряд-место»; принадлежность залу проверяет сервис */
  @ApiProperty({
    example: ['5-7', '5-8'],
    minItems: 1,
    maxItems: 8,
    description: 'коды «ряд-место», зал 8×10',
  })
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

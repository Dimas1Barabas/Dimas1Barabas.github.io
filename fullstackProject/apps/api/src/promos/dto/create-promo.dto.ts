import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PROMO_KINDS } from '../promo.entity';

/** новые промокоды создаёт администратор: POST /api/promos */
export class CreatePromoDto {
  @ApiProperty({
    example: 'CINE10',
    pattern: '^[A-Za-z0-9-]{3,32}$',
    description: 'латиница/цифры/дефис; сохраняется в верхнем регистре',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{3,32}$/, {
    message: 'Код: 3–32 символа — латиница, цифры и дефис',
  })
  code!: string;

  @ApiProperty({ enum: PROMO_KINDS, description: 'вид скидки' })
  @IsIn(PROMO_KINDS, { message: 'Вид скидки: percent или fixed' })
  kind!: 'percent' | 'fixed';

  @ApiProperty({
    example: 10,
    description: 'percent — проценты, fixed — рубли; верхнюю границу для ' +
      'процентов (99) проверяет сервис — вид скидки зависит от kind',
  })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  value!: number;

  @ApiProperty({ example: 100, minimum: 1, description: 'лимит активаций' })
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxActivations!: number;

  @ApiProperty({
    format: 'date-time',
    example: '2026-10-31T00:00:00.000Z',
    description: 'срок действия (в будущем)',
  })
  @IsDateString({}, { message: 'Срок действия — дата в ISO' })
  expiresAt!: string;
}

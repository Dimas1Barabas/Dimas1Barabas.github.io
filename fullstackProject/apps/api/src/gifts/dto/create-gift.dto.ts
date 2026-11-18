import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt } from 'class-validator';
import {
  GIFT_NOMINAL_MAX,
  GIFT_NOMINAL_MIN,
} from '../gifts.logic';

/** покупка сертификата: POST /api/gifts */
export class CreateGiftDto {
  @ApiProperty({
    example: 2000,
    description:
      `Номинал, ₽: целое от ${GIFT_NOMINAL_MIN} до ${GIFT_NOMINAL_MAX}, ` +
      'кратное 100',
  })
  @Type(() => Number)
  @IsInt()
  nominalRub!: number;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/** оплата брони: POST /api/bookings/:id/pay — промокод опционален */
export class PayBookingDto {
  @ApiProperty({
    example: 'CINE10',
    required: false,
    description:
      'Промокод: активация списывается атомарно этой же транзакцией; ' +
      'проигравший в гонке за последний код получает 409 promoExhausted',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{3,32}$/, {
    message: 'Код: 3–32 символа — латиница, цифры и дефис',
  })
  promoCode?: string;
}

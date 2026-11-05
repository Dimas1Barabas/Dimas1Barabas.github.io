import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { CreateBookingDto } from './create-booking.dto';

/**
 * Мгновенный чекаут (новый поток оплаты за флагом checkout.new_flow):
 * бронь + оплата одним вызовом. Наследует поля брони из CreateBookingDto,
 * поля оплаты — те же, что у PayBookingDto (промокод и бонусы опциональны).
 */
export class CheckoutDto extends CreateBookingDto {
  @ApiProperty({
    example: 'CINE10',
    required: false,
    description:
      'Промокод: активируется атомарно транзакцией оплаты; гонку за ' +
      'последний код решает БД — проигравший получает 409 promoExhausted, ' +
      'бронь остаётся в PENDING_PAYMENT',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{3,32}$/, {
    message: 'Код: 3–32 символа — латиница, цифры и дефис',
  })
  promoCode?: string;

  @ApiProperty({
    example: 250,
    required: false,
    description:
      'Сколько бонусов списать (1 бонус = 1 ₽): лимиты те же, что в ' +
      '/bookings/:id/pay — половина чека и баланс счёта',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  useBonuses?: number;
}

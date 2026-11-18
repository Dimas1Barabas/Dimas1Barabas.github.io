import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

/** оплата брони: POST /api/bookings/:id/pay — промокод и бонусы опциональны */
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

  @ApiProperty({
    example: 250,
    required: false,
    description:
      'Сколько бонусов списать (1 бонус = 1 ₽): не больше половины ' +
      'суммы после промокода и не больше баланса — иначе 409 ' +
      'bonusOverLimit / bonusInsufficient',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  useBonuses?: number;

  @ApiProperty({
    example: 'GIFT-AB2CD3EF',
    required: false,
    description:
      'Гифт-сертификат (активируйте код заранее на /gifts): закрывает ' +
      'хвост чека после промокода и бонусов — частично или целиком. ' +
      'Отказ: 404 giftNotFound / 409 giftNotYours / 410 giftExpired / ' +
      '409 giftExhausted (гонку за остаток решает БД)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{5,16}$/, {
    message: 'Код сертификата: 5–16 символов — латиница, цифры и дефис',
  })
  giftCode?: string;
}


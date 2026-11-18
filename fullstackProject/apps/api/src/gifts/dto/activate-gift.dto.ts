import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

/** активация сертификата: POST /api/gifts/activate */
export class ActivateGiftDto {
  @ApiProperty({
    example: 'GIFT-AB2CD3EF',
    description:
      'Код с подаренной карты; регистр и обводки пробелами не важны. ' +
      'Активация одноразовая: повторная — 409 giftAlreadyActivated, ' +
      'просроченная — 410 giftExpired',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^[A-Za-z0-9-]{5,16}$/, {
    message: 'Код: 5–16 символов — латиница, цифры и дефис',
  })
  code!: string;
}

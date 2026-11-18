import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/** активация сертификата: POST /api/gifts/activate */
export class ActivateGiftDto {
  @ApiProperty({
    example: 'GIFT-AB2CD3EF',
    description:
      'Код с подаренной карты; регистр не важен. Активация одноразовая: ' +
      'повторная — 409 giftAlreadyActivated, чужой срок — 410 giftExpired',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{5,16}$/, {
    message: 'Код: 5–16 символов — латиница, цифры и дефис',
  })
  code!: string;
}

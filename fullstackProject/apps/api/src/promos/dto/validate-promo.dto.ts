import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

/** превью промокода на брони: POST /api/promos/validate (без списания) */
export class ValidatePromoDto {
  @ApiProperty({ example: 'cine-10' })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{3,32}$/, {
    message: 'Код: 3–32 символа — латиница, цифры и дефис',
  })
  code!: string;

  @ApiProperty({ format: 'uuid', description: 'бронь, к которой применяется' })
  @IsUUID()
  bookingId!: string;
}

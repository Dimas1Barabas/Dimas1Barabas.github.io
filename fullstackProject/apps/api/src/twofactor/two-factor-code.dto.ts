import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

/**
 * Код подтверждения 2FA: 6 цифр из приложения или backup-код XXXX-XXXX
 * (регистр и разделители нормализуются сервисом). Трим — до валидации
 * длины (тот же приём, что у активации гифт-кода).
 */
export class TwoFactorCodeDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(6, 14)
  @ApiProperty({ example: '123456', description: 'из приложения или backup-код' })
  code!: string;
}

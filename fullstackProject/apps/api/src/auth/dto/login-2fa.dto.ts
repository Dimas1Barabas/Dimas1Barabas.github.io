import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

/**
 * Второй шаг входа: билет из логина + код приложения или backup-код.
 * Галочка «доверять устройству» выпускает токен устройства в cookie.
 */
export class Login2faDto {
  @IsString()
  @Length(20, 100)
  @ApiProperty({ description: 'билет из ответа логина (twoFactorRequired)' })
  ticket!: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(6, 14)
  @ApiProperty({ example: '123456', description: 'из приложения или backup-код' })
  code!: string;

  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional({ description: 'не спрашивать код 30 дней на этом браузере' })
  trustDevice?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @ApiPropertyOptional({ example: 'Браузер на работе' })
  deviceName?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** оба поля опциональны, но хотя бы одно должно быть — проверяет сервис (400) */
export class UpdateProfileDto {
  @ApiProperty({
    example: 'alice@new.com',
    required: false,
    description: 'новый email (приводится к нижнему регистру)',
  })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ example: 'Алиса Новая', required: false })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Имя слишком короткое' })
  @MaxLength(60)
  name?: string;
}

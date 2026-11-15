import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @ApiProperty({ example: 'alice@example.com', description: 'приводится к нижнему регистру' })
  @IsEmail()
  email!: string;

  /** bcrypt использует первые 72 байта — длиннее нет смысла хранить */
  @ApiProperty({ example: 'secret123', minLength: 6, maxLength: 72 })
  @IsString()
  @MinLength(6, { message: 'Пароль короче 6 символов' })
  @MaxLength(72)
  password!: string;

  @ApiProperty({ example: 'Алиса', minLength: 2, maxLength: 60 })
  @IsString()
  @MinLength(2, { message: 'Имя слишком короткое' })
  @MaxLength(60)
  name!: string;

  /** код приглашения друга: опционален, регистр не важен */
  @ApiProperty({
    example: 'AB2CD3EF',
    required: false,
    description: 'код пригласившего — привязка referred_by, бонус обеим сторонам после первой оплаты',
  })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  referralCode?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'secret123', description: 'текущий пароль' })
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  /** bcrypt использует первые 72 байта — длиннее нет смысла хранить */
  @ApiProperty({ example: 'new-secret-9', minLength: 6, maxLength: 72 })
  @IsString()
  @MinLength(6, { message: 'Пароль короче 6 символов' })
  @MaxLength(72)
  newPassword!: string;
}

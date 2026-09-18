import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  /** одноразовый токен из ссылки «письма» (TTL 30 минут) */
  @ApiProperty({ example: 'dG9rZW4tZnJvbS1lbWFpbA' })
  @IsString()
  @MinLength(20)
  token!: string;

  @ApiProperty({ example: 'new-secret-9', minLength: 6, maxLength: 72 })
  @IsString()
  @MinLength(6, { message: 'Пароль короче 6 символов' })
  @MaxLength(72)
  newPassword!: string;
}

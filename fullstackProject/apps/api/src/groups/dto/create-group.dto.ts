import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  MaxLength,
  MinLength,
  IsUUID,
} from 'class-validator';

export class CreateGroupDto {
  /** группа собирается вокруг конкретного сеанса */
  @ApiProperty({ format: 'uuid', description: 'сеанс из каталога /api/movies' })
  @IsUUID()
  sessionId!: string;

  /** имя создателя-участника — гость без логина, как customerName брони */
  @ApiProperty({ example: 'Алиса', minLength: 2, maxLength: 60 })
  @IsString()
  @MinLength(2, { message: 'Имя слишком короткое' })
  @MaxLength(60, { message: 'Имя не длиннее 60 символов' })
  name!: string;
}

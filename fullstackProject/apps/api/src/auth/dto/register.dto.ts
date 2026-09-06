import {
  IsEmail,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  /** bcrypt использует первые 72 байта — длиннее нет смысла хранить */
  @IsString()
  @MinLength(6, { message: 'Пароль короче 6 символов' })
  @MaxLength(72)
  password!: string;

  @IsString()
  @MinLength(2, { message: 'Имя слишком короткое' })
  @MaxLength(60)
  name!: string;
}

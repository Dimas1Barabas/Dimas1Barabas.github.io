import { IsDateString, IsString, MaxLength, MinLength } from 'class-validator';

/** сеанс внутри POST /api/movies (админ) */
export class CreateSessionDto {
  /** название зала — подпись в UI */
  @IsString()
  @MinLength(1, { message: 'Название зала пустое' })
  @MaxLength(40)
  hall!: string;

  @IsDateString()
  startsAt!: string;
}

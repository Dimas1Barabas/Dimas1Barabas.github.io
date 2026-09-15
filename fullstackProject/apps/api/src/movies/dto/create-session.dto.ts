import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsString, MaxLength, MinLength } from 'class-validator';

/** сеанс внутри POST /api/movies (админ) */
export class CreateSessionDto {
  /** название зала — подпись в UI */
  @ApiProperty({ example: 'IMAX', maxLength: 40 })
  @IsString()
  @MinLength(1, { message: 'Название зала пустое' })
  @MaxLength(40)
  hall!: string;

  @ApiProperty({ example: '2026-10-01T19:30:00.000Z', format: 'date-time' })
  @IsDateString()
  startsAt!: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/** сканер на входе в зал: POST /api/bookings/tickets/verify */
export class VerifyTicketDto {
  @ApiProperty({
    example: 'CINE1|11111111-1111-4111-8111-111111111111|5-7|1789713600|2e0254421e0f61336e75bd1c6af05d99',
    description: 'QR-строка билета как её печатает фронт',
  })
  @IsString()
  @Matches(/\|/, { message: 'Это не похоже на QR-строку билета' })
  @MaxLength(256)
  payload!: string;
}

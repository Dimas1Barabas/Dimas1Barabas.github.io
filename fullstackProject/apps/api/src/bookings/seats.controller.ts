import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { SeatMapDto } from './hall';
import { BookingsService } from './bookings.service';

/**
 * Карта занятости зала сеанса: GET /api/sessions/:sessionId/seats.
 * Живёт в модуле броней (данные — их занятость), а не в модуле фильмов.
 */
@Public()
@ApiTags('sessions')
@Controller('sessions/:sessionId/seats')
export class SeatsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Карта занятости зала сеанса',
    description: 'Без кэша — всегда свежая: occupied включает и резервы (PENDING_PAYMENT)',
  })
  @ApiOkResponse({ type: SeatMapDto })
  @ApiNotFoundResponse({ description: 'Сеанс не найден' })
  seats(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.bookings.seatMap(sessionId);
  }
}

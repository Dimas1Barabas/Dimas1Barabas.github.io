import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { BookingsService } from './bookings.service';

/**
 * Карта занятости зала сеанса: GET /api/sessions/:sessionId/seats.
 * Живёт в модуле броней (данные — их занятость), а не в модуле фильмов.
 */
@Public()
@Controller('sessions/:sessionId/seats')
export class SeatsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  seats(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.bookings.seatMap(sessionId);
  }
}

import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { BookingsService } from './bookings.service';

/**
 * Карта занятости зала сеанса: GET /api/movies/:movieId/seats.
 * Живёт в модуле броней (данные — их занятость), а не в модуле фильмов.
 */
@Controller('movies/:movieId/seats')
export class SeatsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  seats(@Param('movieId', ParseUUIDPipe) movieId: string) {
    return this.bookings.seatMap(movieId);
  }
}

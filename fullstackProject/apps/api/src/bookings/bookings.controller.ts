import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateBookingDto) {
    return this.bookings.create(dto);
  }

  @Get()
  list(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : 30;
    const safe = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), 100)
      : 30;
    return this.bookings.list(safe);
  }

  @Get('stats')
  stats() {
    return this.bookings.stats();
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  MessageEvent,
  Param,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { interval, merge, map, Observable } from 'rxjs';
import { BookingStream } from './booking-stream';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

/** период heartbeat-событий: держит соединие живым через прокси */
const PING_MS = 25_000;

@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly bus: BookingStream,
  ) {}

  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateBookingDto) {
    return this.bookings.create(dto);
  }

  /** запуск компенсирующей саги: возврат платежа через Go-воркера */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string) {
    return this.bookings.cancel(id);
  }

  /**
   * Server-Sent Events: каждому подключённому клиенту прилетает событие
   * «booking» с изменённой бронью и статистикой — без опроса.
   * «ping» — heartbeat, браузеры его молча игнорируют.
   */
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return merge(
      this.bus.events$.pipe(
        map((payload) => ({ type: 'booking', data: payload })),
      ),
      interval(PING_MS).pipe(map(() => ({ type: 'ping', data: '' }))),
    );
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

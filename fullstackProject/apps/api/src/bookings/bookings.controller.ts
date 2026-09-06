import {
  Body,
  Controller,
  Get,
  HttpCode,
  MessageEvent,
  Param,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import { interval, merge, map, Observable } from 'rxjs';
import { AuthUser } from '../auth/auth-user';
import { Public } from '../auth/public.decorator';
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

  /** покупает билет тот, кто предъявил токен: имя и владелец — из JWT */
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateBookingDto, @Req() req: { user: AuthUser }) {
    return this.bookings.create(dto, req.user);
  }

  /** запуск компенсирующей саги: возврат платежа через Go-воркера */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.bookings.cancel(id, req.user);
  }

  /**
   * Server-Sent Events: каждому подключённому клиенту прилетает событие
   * «booking» с изменённой бронью и статистикой — без опроса.
   * «ping» — heartbeat, браузеры его молча игнорируют.
   *
   * @Public: EventSource не умеет заголовок Authorization — токен пришлось
   * бы передавать в query; стрим витринный (демо-табло), открываем без него.
   */
  @Public()
  @Sse('stream')
  stream(): Observable<MessageEvent> {
    return merge(
      this.bus.events$.pipe(
        map((payload) => ({ type: 'booking', data: payload })),
      ),
      interval(PING_MS).pipe(map(() => ({ type: 'ping', data: '' }))),
    );
  }

  /** демо-табло: последние брони и статистика открыты всем */
  @Public()
  @Get()
  list(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : 30;
    const safe = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), 100)
      : 30;
    return this.bookings.list(safe);
  }

  @Public()
  @Get('stats')
  stats() {
    return this.bookings.stats();
  }
}

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
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { interval, merge, map, Observable } from 'rxjs';
import { AuthUser } from '../auth/auth-user';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { BookingDto } from './booking.entity';
import { BookingStream } from './booking-stream';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { PayBookingDto } from './dto/pay-booking.dto';
import { VerifyTicketDto } from './dto/verify-ticket.dto';
import { TicketDto, TicketVerifyResultDto } from './ticket.logic';

/** период heartbeat-событий: держит соединие живым через прокси */
const PING_MS = 25_000;

@ApiTags('bookings')
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly bus: BookingStream,
  ) {}

  /** покупает билет тот, кто предъявил токен: имя и владелец — из JWT */
  @Post()
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Создать бронь (резерв мест)',
    description:
      'Бронь рождается в PENDING_PAYMENT с дедлайном оплаты `expires_at` ' +
      '(окно задаёт PAYMENT_TIMEOUT_MS). Места занимаются той же транзакцией; ' +
      'гонку за место решает uq(session_id, seat) — проигравший получает 409 ' +
      'с списком занятых мест (`seatsTaken`).',
  })
  @ApiCreatedResponse({ type: BookingDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiNotFoundResponse({ description: 'Сеанс не найден' })
  @ApiConflictResponse({ description: 'Места уже заняты — код seatsTaken, список в теле' })
  create(@Body() dto: CreateBookingDto, @Req() req: { user: AuthUser }) {
    return this.bookings.create(dto, req.user);
  }

  /** оплата брони: запускает проведение платежа Go-воркером */
  @Post(':id/pay')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Оплатить бронь (опционально с промокодом)',
    description:
      'Условный UPDATE переводит PENDING_PAYMENT → PENDING и публикует ' +
      'booking.created воркеру. Гонку с таймаутом резерва и двойным кликом ' +
      'решает БД — проигравший получает 409. Промокод из тела активируется ' +
      'той же транзакцией: атомарный инкремент used_count при запасе и ' +
      'живом сроке, скидка уходит в total_rub (воркер списывает уже её). ' +
      'Проигравший в гонке за последний код получает 409 promoExhausted, ' +
      'бронь остаётся в PENDING_PAYMENT. Вердикт (CONFIRMED/FAILED) ' +
      'придёт по SSE-стриму.',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiNotFoundResponse({ description: 'Бронь не найдена' })
  @ApiConflictResponse({
    description:
      'Бронь уже оплачена/истекла/отменена (status) или промокод исчерпан (promoExhausted)',
  })
  pay(
    @Param('id') id: string,
    @Body() dto: PayBookingDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.bookings.pay(id, req.user, dto.promoCode);
  }

  /** запуск компенсирующей саги: возврат платежа через Go-воркера */
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Отменить бронь',
    description:
      'Неоплаченная (PENDING_PAYMENT) гасится сразу в CANCELLED, места ' +
      'свободны мгновенно. Подтверждённая запускает сагу возврата: ' +
      'CANCELLING → вердикт воркера; при отказе «банка» бронь откатывается ' +
      'в CONFIRMED, места остаются за клиентом.',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiNotFoundResponse({ description: 'Бронь не найдена' })
  @ApiConflictResponse({ description: 'Бронь не в отменяемом статусе (решает условный UPDATE)' })
  cancel(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.bookings.cancel(id, req.user);
  }

  /** билеты CONFIRMED-брони: по одному на место, с подписью для QR-кода */
  @Get(':id/tickets')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Билеты брони (по одному на место)',
    description:
      'Билет — производная брони, а не отдельная сущность: выдаётся ' +
      'только по CONFIRMED и умирает вместе с бронью. Подпись HMAC-SHA256 ' +
      'детерминирована (бронь + место + сеанс), поэтому пересчитывается ' +
      'на каждый запрос и переживает рестарты API. QR-строку ' +
      '`CINE1|bookingId|seat|epoch|sig` фронт собирает из этих полей сам.',
  })
  @ApiOkResponse({ type: [TicketDto] })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiNotFoundResponse({ description: 'Бронь не найдена' })
  @ApiForbiddenResponse({ description: 'Чужая бронь' })
  @ApiConflictResponse({
    description: 'Бронь не подтверждена — код bookingNotConfirmed',
  })
  tickets(@Param('id') id: string, @Req() req: { user: AuthUser }) {
    return this.bookings.tickets(id, req.user);
  }

  /** сканер на входе в зал: контролёр предъявляет QR-строку билета */
  @Post('tickets/verify')
  @HttpCode(200)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Проверить QR-билета (сканер на входе)',
    description:
      'Вердикт, а не ошибка: 200 всегда, валидность — в `valid`, причина ' +
      'отказа — в `reason` (подделка подписи, бронь не подтверждена, ' +
      'чужое место, сеанс уже прошёл). Контролёру нужен экран, а не 4xx.',
  })
  @ApiOkResponse({ type: TicketVerifyResultDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Нужна роль admin' })
  verify(@Body() dto: VerifyTicketDto) {
    return this.bookings.verifyTicket(dto.payload);
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
  @ApiOperation({
    summary: 'SSE-стрим броней (демо-табло)',
    description:
      'text/event-stream: событие `booking` с каждой мутацией брони + ' +
      'heartbeat `ping` каждые 25 c. try-it-out здесь не покажет поток — ' +
      'смотрите вкладку Network или `curl -N`.',
  })
  stream(): Observable<MessageEvent> {
    return merge(
      this.bus.events$.pipe(
        map((payload) => ({ type: 'booking', data: payload })),
      ),
      interval(PING_MS).pipe(map(() => ({ type: 'ping', data: '' }))),
    );
  }

  /** личный кабинет: свои брони по JWT (не публично — владелец из токена) */
  @Get('my')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Мои билеты', description: 'Брони владельца из JWT, свежие сверху; фильтрация в БД' })
  @ApiOkResponse({ type: [BookingDto] })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(@Req() req: { user: AuthUser }) {
    return this.bookings.my(req.user);
  }

  /** демо-табло: последние брони и статистика открыты всем */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Последние брони (демо-табло)' })
  @ApiQuery({ name: 'limit', required: false, example: 30, description: '1..100, дефолт 30' })
  @ApiOkResponse({ type: [BookingDto] })
  list(@Query('limit') limit?: string) {
    const parsed = limit ? Number.parseInt(limit, 10) : 30;
    const safe = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), 100)
      : 30;
    return this.bookings.list(safe);
  }

  @Public()
  @Get('stats')
  @ApiOperation({ summary: 'Статистика броней', description: 'Счётчики по статусам статусной машины' })
  stats() {
    return this.bookings.stats();
  }
}

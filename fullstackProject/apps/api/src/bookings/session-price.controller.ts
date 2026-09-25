import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { BookingsService } from './bookings.service';
import { SessionQuoteDto } from './dto/session-quote.dto';

/**
 * Витрина цены сеанса: GET /api/sessions/:sessionId/price. Живёт
 * в модуле броней: цена места нужна и витрине выбора, и create() —
 * источник один, Тарификатор за gRPC.
 */
@Public()
@ApiTags('sessions')
@Controller('sessions/:sessionId/price')
export class SessionPriceController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Цена места сеанса с раскладкой факторов',
    description:
      'Спрашивает Тарификатора (gRPC): база афиши × время суток × выходной × заполненность. Недоступность сервиса — не ошибка: базовая цена с dynamic=false',
  })
  @ApiOkResponse({ type: SessionQuoteDto })
  @ApiNotFoundResponse({ description: 'Сеанс не найден' })
  price(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.bookings.sessionPrice(sessionId);
  }
}

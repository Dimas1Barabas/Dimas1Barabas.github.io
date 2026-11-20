import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { Roles } from '../auth/roles.decorator';
import { BookingDto } from '../bookings/booking.entity';
import { BookingsService } from '../bookings/bookings.service';
import { DetectiveClient } from './detective.client';
import { DetectiveShowcaseClient } from './detective-showcase.client';
import { ResolveFraudDto } from './dto/resolve-fraud.dto';

/**
 * Админка антифрода: витрина решений «Детектива» и рука человека.
 * Контроллер живёт в AdminModule (импортирует BookingsModule и
 * FraudModule): в самом FraudModule был бы цикл — BookingsModule
 * импортирует его ради клиента скоринга.
 *
 * Порядок резолва: сначала решение в детективе (аудит не теряется),
 * затем бизнес-действие; конфликт бизнес-слоя (бронь истекла по
 * таймауту резерва) — 409 fraudResolveConflict, решение в витрине
 * остаётся честным.
 */
@ApiTags('admin/fraud')
@Roles('admin')
@Controller('admin/fraud')
export class FraudAdminController {
  private readonly logger = new Logger('FraudAdminController');

  constructor(
    private readonly showcase: DetectiveShowcaseClient,
    private readonly detective: DetectiveClient,
    private readonly bookings: BookingsService,
  ) {}

  @Get()
  @ApiBearerAuth()
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [
      'auto_allowed',
      'auto_blocked',
      'pending_review',
      'approved',
      'rejected',
    ],
    description: 'Фильтр по статусу; pending_review — рабочая очередь ревью',
  })
  @ApiOperation({
    summary: 'Витрина решений антифрода (админка)',
    description:
      'Решения «Детектива» свежими сверху: факты, скор, коды сработавших ' +
      'правил и статус. Источник — HTTP-витрина сервиса; её недоступность ' +
      'деградирует в пустой список (fail-soft), это не критичный путь.',
  })
  @ApiOkResponse()
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  async list(@Query('status') status?: string) {
    return { decisions: await this.showcase.decisions(status) };
  }

  @Post(':bookingId/resolve')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Решить судьбу брони из очереди ревью (админка)',
    description:
      'approve — системная оплата брони (промокоды/бонусы не применяются: ' +
      'чекаут их уже нёс в момент холда), reject — отмена, места в продажу. ' +
      'Гонку двух админов решает Детектив: повторное решение — 409 ' +
      'fraudAlreadyResolved. Если бронь за время ревью истекла по таймауту ' +
      'резерва — 409 fraudResolveConflict: решение зафиксировано, бронь ' +
      'уже закрыта иначе.',
  })
  @ApiOkResponse({ type: BookingDto })
  @ApiConflictResponse({
    description:
      'Уже решено (fraudAlreadyResolved) либо бронь закрыта иначе ' +
      '(fraudResolveConflict) — с текущим статусом в теле',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  async resolve(
    @Param('bookingId') bookingId: string,
    @Body() dto: ResolveFraudDto,
    @Req() req: { user: AuthUser },
  ) {
    let decision;
    try {
      decision = await this.detective.resolve({
        bookingId,
        action: dto.action,
        resolvedBy: req.user?.email ?? 'admin',
      });
    } catch (err) {
      throw this.resolveRefusal(err, bookingId);
    }

    // аудит решения записан — исполняем бизнес-часть. Любой отказ здесь
    // (бронь истекла по таймауту резерва, закрыта иначе, гонка) — это
    // конфликт резолва, а не причина прятать зафиксированное решение:
    // витрина остаётся честной, повторный резолв получит AlreadyResolved
    try {
      if (dto.action === 'approve') {
        const booking = await this.bookings.payReviewed(bookingId);
        this.logger.log(
          `Ревью антифрода: бронь ${bookingId} одобрена (${decision.status}) — оплата запущена`,
        );
        return { resolved: 'approved', booking };
      }
      const cancelled = await this.bookings.cancelReviewed(bookingId);
      if (!cancelled) {
        // решение зафиксировано, но бронь уже не в PENDING_PAYMENT
        throw new Error('бронь уже не ждёт оплаты');
      }
      this.logger.log(
        `Ревью антифрода: бронь ${bookingId} отклонена (${decision.status}) — места свободны`,
      );
      return { resolved: 'rejected', booking: cancelled };
    } catch (err) {
      this.logger.warn(
        `Ревью ${bookingId}: решение ${dto.action} зафиксировано, бизнес-шаг не прошёл: ${String(err)}`,
      );
      throw conflict(bookingId);
    }
  }

  /** ошибка резолва в детективе → честный HTTP-код админке */
  private resolveRefusal(err: unknown, bookingId: string): HttpException {
    const message = String(err);
    this.logger.warn(`resolve ${bookingId}: ${message}`);
    if (message.includes('NOT_FOUND') || message.includes('не найдено')) {
      return new HttpException(
        { code: 'fraudDecisionNotFound', bookingId },
        HttpStatus.NOT_FOUND,
      );
    }
    if (
      message.includes('FAILED_PRECONDITION') ||
      message.includes('уже закрыто')
    ) {
      return new HttpException(
        { code: 'fraudAlreadyResolved', bookingId },
        HttpStatus.CONFLICT,
      );
    }
    return new HttpException(
      'Детектив недоступен — решение не зафиксировано',
      HttpStatus.BAD_GATEWAY,
    );
  }
}

/** конфликт бизнес-слоя после зафиксированного решения */
function conflict(bookingId: string): HttpException {
  return new HttpException(
    {
      statusCode: 409,
      error: 'Conflict',
      message:
        'Решение зафиксировано, но бронь уже закрыта иначе (таймаут резерва) — мест в продаже нет',
      code: 'fraudResolveConflict',
      bookingId,
    },
    HttpStatus.CONFLICT,
  );
}

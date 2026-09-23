import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { BonusAccountDto } from './bonus.service';
import { BonusService } from './bonus.service';

/**
 * Бонусный счёт: кэшбэк после CONFIRMED-брони, списание при оплате —
 * не больше половины чека. Движения — ledger, баланс всегда считается
 * от источника (см. BookingsService.pay и handleProcessed/handleRefunded).
 */
@ApiTags('bonuses')
@ApiBearerAuth()
@Controller('bonuses')
export class BonusController {
  constructor(private readonly bonuses: BonusService) {}

  @Get('my')
  @ApiOperation({
    summary: 'Бонусный счёт: баланс и история',
    description:
      'Баланс — SUM(accrual) − SUM(spend): начисления (кэшбэк, возвраты) ' +
      'минус списания (оплаты, гашение кэшбэка при возврате). ' +
      'Курс 1 бонус = 1 ₽. История — последние движения, свежие сверху. ' +
      'Баланс пригодится экрану оплаты: списать можно не больше половины ' +
      'чека (после промокода) и не больше баланса.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 20, description: 'сколько движений в истории, 1..100' })
  @ApiOkResponse({ type: BonusAccountDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(
    @Req() req: { user: AuthUser },
    @Query('limit') limit?: string,
  ): Promise<BonusAccountDto> {
    const parsed = limit ? Number.parseInt(limit, 10) : 20;
    const safe = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), 100)
      : 20;
    return this.bonuses.my(req.user, safe);
  }
}

import { Controller, Get, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { cashbackPercent } from '../bonus/cashback-percent';
import { LoyaltyStatusDto, LoyaltyService } from './loyalty.service';

/**
 * Уровни лояльности «Киноман» (этап 38): витрина личного кабинета.
 * Начислений и движений здесь нет — уровень выводится из трат
 * (CONFIRMED-брони), перки применяются на своих местах: кэшбэк в
 * вердиктном цикле, скидка в кинобаре, надбавки спроса — Тарификатор.
 */
@ApiTags('loyalty')
@ApiBearerAuth()
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('my')
  @ApiOperation({
    summary: 'Уровень «Киномана»: перки и прогресс',
    description:
      'Уровень по пожизненным тратам (SUM(total_rub) CONFIRMED-броней): ' +
      'Новичок → Зритель → Киноман → Легенда экрана. Перки: прибавка ' +
      'кэшбэка к базовому проценту, скидка кинобара, отсутствие надбавок ' +
      'спроса (Киноман и выше). Пороги — продовые дефолты или ' +
      'LOYALTY_TIERS_RUB. Возврат брони понижает сумму самим статусом.',
  })
  @ApiOkResponse({ type: LoyaltyStatusDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(@Req() req: { user: AuthUser }): Promise<LoyaltyStatusDto> {
    // базовый процент — env-конфиг бонусов: прибавка уровня ложится сверху
    return this.loyalty.my(req.user, cashbackPercent());
  }
}

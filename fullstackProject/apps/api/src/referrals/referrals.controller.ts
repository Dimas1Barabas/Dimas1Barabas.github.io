import { Controller, Get, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { ReferralsMyDto } from './referrals.service';
import { ReferralsService } from './referrals.service';

/**
 * Реферальная программа: код приглашения, статистика «кто пришёл и
 * дошёл ли до оплаты», размеры бонусов. Начисление — в
 * BookingsService.handleProcessed при первой оплаченной брони друга.
 */
@ApiTags('referrals')
@ApiBearerAuth()
@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get('my')
  @ApiOperation({
    summary: 'Код приглашения и статистика приглашений',
    description:
      'Код для ссылки регистрации (?ref=CODE), размеры бонусов ' +
      '(пригласившему — за первую оплаченную бронь друга, другу — ' +
      'welcome за ту же оплату), список приглашённых с маскированными ' +
      'email и итоги: сколько пришло / сколько оплатило / сколько ' +
      'реферальных бонусов начислено. Юзерам, зарегистрированным до ' +
      'рефералки, код догенерируется при этом запросе.',
  })
  @ApiOkResponse({ type: ReferralsMyDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(@Req() req: { user: AuthUser }): Promise<ReferralsMyDto> {
    return this.referrals.my(req.user);
  }
}

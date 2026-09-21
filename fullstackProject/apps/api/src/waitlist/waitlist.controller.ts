import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import {
  WaitlistEntryDto,
  WaitlistMyEntryDto,
} from './waitlist.entity';
import { WaitlistService } from './waitlist.service';

/**
 * Лист ожидания: встают, когда зал полного сеанса. При освобождении
 * места уведомляется голова очереди, место НЕ резервируется — честная
 * гонка (см. WaitlistService и консьюмер waitlist.seat.released).
 */
@ApiTags('waitlist')
@ApiBearerAuth()
@Controller('waitlist')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post(':sessionId')
  @ApiOperation({
    summary: 'Встать в лист ожидания сеанса',
    description:
      'Только для полного и ещё не начавшегося сеанса. Позиция — ' +
      'порядок среди WAITING по времени входа. Повторный вход после ' +
      'уведомления или выхода снова доступен, но в конец очереди.',
  })
  @ApiCreatedResponse({
    type: WaitlistEntryDto,
    description: 'Запись создана (или реактивирована), position — место в очереди',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiNotFoundResponse({ description: 'Сеанс не найден' })
  @ApiConflictResponse({
    description:
      'Уже в очереди — код waitlistAlready; на сеансе есть свободные места — код sessionNotFull',
  })
  @ApiGoneResponse({ description: 'Сеанс уже начался — код sessionPassed' })
  join(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: { user: AuthUser },
  ): Promise<WaitlistEntryDto> {
    return this.waitlist.join(sessionId, req.user);
  }

  @Delete(':sessionId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Выйти из листа ожидания сеанса' })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiNotFoundResponse({
    description: 'Записи нет (или уже вышли) — код waitlistEntryNotFound',
  })
  leave(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: { user: AuthUser },
  ): Promise<void> {
    return this.waitlist.leave(sessionId, req.user);
  }

  @Get('my')
  @ApiOperation({
    summary: 'Мои записи в листах ожидания',
    description:
      'Только будущие сеансы, ближайший сверху. position — место среди ' +
      'WAITING; NOTIFIED значит «место уже освобождалось — вы в гонке».',
  })
  @ApiOkResponse({ type: [WaitlistMyEntryDto] })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(@Req() req: { user: AuthUser }): Promise<WaitlistMyEntryDto[]> {
    return this.waitlist.my(req.user);
  }
}

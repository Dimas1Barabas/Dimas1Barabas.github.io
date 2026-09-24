import { Controller, Get, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { RecommendationsDto } from './recommendations.service';
import { RecommendationsService } from './recommendations.service';

/**
 * «Вам понравится»: персональный топ афиши от КиноСоветника (gRPC).
 * Эндпоинт за JWT — профиль зрителя имеет смысл только для владельца.
 */
@ApiTags('recommendations')
@ApiBearerAuth()
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly recos: RecommendationsService) {}

  @Get('my')
  @ApiOperation({
    summary: 'Персональные рекомендации («Вам понравится»)',
    description:
      'Топ афиши по профилю зрителя: КиноСоветник (Go, gRPC) копит сигналы ' +
      '(подтверждённые брони, отзывы) и ранжирует текущую афишу — жанровые ' +
      'веса профиля + косинусная близость + рейтинг фильма. Просмотренное ' +
      'исключается. Ответ кэшируется на 60 c; basis поясняет, на чём построен ' +
      'топ (profile/popular/empty) или что сервис недоступен (unavailable ' +
      '— витрина просто скрывает блок, это не ошибка).',
  })
  @ApiOkResponse({ type: RecommendationsDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  my(@Req() req: { user: AuthUser }): Promise<RecommendationsDto> {
    return this.recos.my(req.user.id);
  }
}

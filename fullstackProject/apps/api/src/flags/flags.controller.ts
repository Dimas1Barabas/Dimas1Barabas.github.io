import { Controller, Get, Param, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { FlagsEvaluator } from './flags.evaluator';

/**
 * Витринный вердикт флагов: «показывать ли мне новую фичу?» Web спрашивает
 * перед тем, как рисовать точку применения. Тот же локальный вердикт из
 * кэша состояний, что решает допуск маршрута в FeatureFlagGuard, и та же
 * сущность бакетинга (id из JWT) — кнопка и маршрут не расходятся:
 * кнопка видна ровно тогда, когда POST пройдёт гвард. Процент раскатки
 * наружу не отдаём: клиенту достаточно включён/причина. У эксперимента
 * вердикт несёт вариант сущности — точка применения может различать опыт.
 * Каждый показ точки применения засчитывается экспозицией эксперимента
 * (fire-and-forget, метрики не задерживают ответ).
 */
@ApiTags('flags')
@Controller('flags')
export class FlagsController {
  constructor(private readonly evaluator: FlagsEvaluator) {}

  @Get(':key')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Вердикт флага для вошедшего (точка применения на витрине)',
    description:
      'Локальный вердикт из кэша состояний — без похода в сервис. ' +
      'Причины: on / percentage / variant / base / flag_off / kill_switch / ' +
      'not_found. У A/B-эксперимента причина variant/base и имя варианта ' +
      '(пустое — база, контрольный опыт). Флага нет или «Суфлёр» недоступен ' +
      'после старта — enabled=false: новая фича не засветится аварией ' +
      'сервиса (fail-safe, как у гварда). Сущность бакетинга — id из JWT: ' +
      'раскатка делит кнопки и маршруты одинаково.',
  })
  @ApiOkResponse({
    description:
      '{key, enabled, reason, variant} — процент раскатки не отдаём',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  async verdict(
    @Param('key') key: string,
    @Req() req: { user: AuthUser },
  ): Promise<{
    key: string;
    enabled: boolean;
    reason: string;
    variant: string;
  }> {
    const verdict = await this.evaluator.isEnabled(key, req.user.id);
    // точка применения показана — экспозиция эксперимента (не ждём ответа)
    this.evaluator.reportExposure(key, req.user.id);
    // percentage — внутренняя кухня раскатки, клиенту не нужна
    return {
      key,
      enabled: verdict.enabled,
      reason: verdict.reason,
      variant: verdict.variant,
    };
  }
}

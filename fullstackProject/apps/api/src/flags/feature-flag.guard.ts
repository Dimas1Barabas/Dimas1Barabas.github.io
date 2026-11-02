import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../auth/auth-user';
import { FEATURE_FLAG_KEY } from './feature-flag.decorator';
import { FlagsEvaluator } from './flags.evaluator';

/**
 * Гвард флагов: перед допуском маршрута считает вердикт локально
 * (кэш состояний — в сеть не ходим). Сущность для бакетинга — та же
 * цепочка ключей, что у лимитов: id из JWT → email из тела → ip.
 * Сервис недоступен — вердикты по офлайн-снимку; флага нет — скрыта
 * (fail-safe: новая фича не «засветится» аварией Суфлёра).
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly evaluator: FlagsEvaluator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const flagKey = this.reflector.getAllAndOverride<string>(
      FEATURE_FLAG_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!flagKey) return true; // без метки гвард нейтрален

    const req = context.switchToHttp().getRequest<
      {
        user?: AuthUser;
        body?: { email?: unknown };
        ip?: string;
      } & Record<string, unknown>
    >();
    const email =
      typeof req.body?.email === 'string'
        ? req.body.email.trim().toLowerCase()
        : '';
    const entityId = req.user?.id ?? (email || `ip:${req.ip ?? 'unknown'}`);

    const verdict = await this.evaluator.isEnabled(flagKey, entityId);
    if (verdict.enabled) return true;

    throw new HttpException(
      {
        statusCode: 403,
        error: 'Forbidden',
        message: 'Фича пока недоступна',
        code: 'featureDisabled',
        flag: flagKey,
        reason: verdict.reason,
      },
      403,
    );
  }
}

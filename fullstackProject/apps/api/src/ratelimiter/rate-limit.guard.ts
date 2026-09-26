import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser } from '../auth/auth-user';
import {
  RATE_LIMITED_ACTION,
  RateLimitedAction,
} from './rate-limited.decorator';
import { CheckRateGrpcResponse, RateLimiterClient } from './ratelimiter.client';

/**
 * Гвард лимитов: перед допуском действия спрашивает у Привратника один
 * токен корзины. Порядок гарантирован архитектурой Nest: глобальные
 * гварды (JwtAuthGuard через APP_GUARD) отрабатывают раньше маршрутных,
 * поэтому на POST /bookings req.user уже заполнен; на login (@Public)
 * ключ — email из тела: body парсится express-мидлварью до гвардов,
 * ValidationPipe — после, так что даже непрошедший валидацию email
 * годится как ключ. Любой сбой клиента — warn и пропуск: лимит не
 * должен ломать бронь или вход (философия fallback'а Тарификатора).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger('RateLimitGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly ratelimiter: RateLimiterClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<RateLimitedAction>(
      RATE_LIMITED_ACTION,
      [context.getHandler(), context.getClass()],
    );
    if (!action) return true; // без метки гвард нейтрален

    const req = context.switchToHttp().getRequest<
      { user?: AuthUser; body?: { email?: unknown }; ip?: string } & Record<string, unknown>
    >();
    // ключ: у авторизованного — id из JWT, у входа — email, прочее — ip
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const key = req.user?.id ?? (email || `ip:${req.ip ?? 'unknown'}`);

    let res: CheckRateGrpcResponse;
    try {
      res = await this.ratelimiter.check({ action, key });
    } catch (err) {
      this.logger.warn(
        `Привратник недоступен (${action} ${key}) — пропуск: ${String(err)}`,
      );
      return true; // fail-open: лимит не ломает функциональность
    }
    if (typeof res.allowed !== 'boolean') {
      // мусор в ответе = недоступность: не гадаем, пропускаем
      this.logger.warn(
        `Привратник ответил мусором (${action} ${key}): ${JSON.stringify(res)}`,
      );
      return true;
    }
    if (res.allowed) return true;

    const retryAfterSec = Math.max(1, Math.ceil((res.retryAfterMs ?? 1000) / 1000));
    context
      .switchToHttp()
      .getResponse<{ setHeader?: (name: string, value: string) => void }>()
      ?.setHeader?.('Retry-After', String(retryAfterSec));
    throw new HttpException(
      {
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Слишком часто — попробуйте позже',
        code: 'rateLimited',
        retryAfterSec,
      },
      429,
    );
  }
}

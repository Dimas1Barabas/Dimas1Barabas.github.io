import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Глобальный guard: по умолчанию все эндпоинты требуют Bearer-JWT,
 * витрина помечается @Public(). Классика «deny by default».
 *
 * Не-HTTP контексты (rmq-консьюмеры, ws-гейтвей) пропускаем без
 * проверки — passport ждёт request.headers, а на ConsumeMessage его
 * нет: guard ронял КАЖДЫЙ вердикт воркера, live-int поймал обвал
 * событийного контура (как MetricsInterceptor пропускает ws).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements CanActivate {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}

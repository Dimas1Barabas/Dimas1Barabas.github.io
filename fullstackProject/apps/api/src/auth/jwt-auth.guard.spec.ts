import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import { JwtAuthGuard } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Границы JwtAuthGuard: не-HTTP контексты проходят без паспорта,
 * @Public() на HTTP — без токена, обычный HTTP — отдан passport.
 *
 * Регрессия rmq-ветки: golevelup прогоняет @RabbitSubscribe-хендлеры
 * через общий конвейер Nest — глобальный APP_GUARD доходит и до них.
 * passport ждёт request.headers, а в rmq-контексте «запросом» приходит
 * ConsumeMessage (properties.headers, не headers) — guard ронял каждый
 * вердикт воркера; поймано live-int против живого брокера (03.10).
 */

/** двойник контекста: switchToHttp у не-HTTP контекстов кидает —
 * если guard сунется туда, тест упадёт громко, как прод */
function makeRmqContext(): ExecutionContext {
  return {
    getType: () => 'rmq',
    switchToHttp: () => {
      throw new Error('rmq-контекст не должен попадать в HTTP-конвейер');
    },
    getHandler: () => {
      throw new Error('rmq-контекст не должен смотреть HTTP-метаданные');
    },
    getClass: () => {
      throw new Error('rmq-контекст не должен смотреть HTTP-метаданные');
    },
  } as unknown as ExecutionContext;
}

/** HTTP-контекст-двойник с управляемыми Reflect-метаданными хендлера */
function makeHttpContext(isPublic = false): ExecutionContext {
  const handler = () => undefined;
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }),
    getHandler: () => handler,
    getClass: () => class T {},
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const reflector = new Reflector();
  const guard = new JwtAuthGuard(reflector);

  it('rmq-контекст консьюмера проходит без паспорта', () => {
    // до фикса: super.canActivate → passport → request.headers
    // от ConsumeMessage → «Cannot read properties of undefined»
    expect(guard.canActivate(makeRmqContext())).toBe(true);
  });

  it('ws-контекст гейтвея проходит без паспорта', () => {
    const wsContext = {
      getType: () => 'ws',
      switchToHttp: () => {
        throw new Error('ws-контекст не должен попадать в HTTP-конвейер');
      },
    } as unknown as ExecutionContext;
    expect(guard.canActivate(wsContext)).toBe(true);
  });

  it('@Public()-эндпоинт пропускается без вызова passport', () => {
    expect(guard.canActivate(makeHttpContext(true))).toBe(true);
  });

  it('обычный HTTP-эндпоинт отдается passport (без токена — 401)', async () => {
    // super.canActivate идёт в паспорт: стратегии jwt в юнит-окружении
    // нет, passport ответит ошибкой — важно, что guard НЕ пропустил
    // запрос сам, а делегировал проверку
    await expect(guard.canActivate(makeHttpContext())).rejects.toThrow();
  });
});

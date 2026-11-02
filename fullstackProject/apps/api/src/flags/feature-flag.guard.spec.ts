import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagGuard } from './feature-flag.guard';
import { FlagsEvaluator } from './flags.evaluator';

/** ExecutionContext-стаб: метаданные маршрута + HTTP-запрос */
function makeContext(req: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as never;
}

function makeGuard(
  flagKey: string | undefined,
  verdict: { enabled: boolean; reason: string },
) {
  const reflector = {
    getAllAndOverride: () => flagKey,
  } as unknown as Reflector;
  const seen: string[] = [];
  const evaluator = {
    isEnabled: async (key: string, entityId: string) => {
      seen.push(`${key}|${entityId}`);
      return verdict;
    },
  } as unknown as FlagsEvaluator;
  return { guard: new FeatureFlagGuard(reflector, evaluator), seen };
}

describe('FeatureFlagGuard', () => {
  it('без метки гвард нейтрален', async () => {
    const { guard, seen } = makeGuard(undefined, { enabled: false, reason: 'flag_off' });
    await expect(guard.canActivate(makeContext({}))).resolves.toBe(true);
    expect(seen).toEqual([]);
  });

  it('флаг включён — маршрут открыт', async () => {
    const { guard } = makeGuard('checkout.new_flow', { enabled: true, reason: 'on' });
    await expect(
      guard.canActivate(makeContext({ user: { id: 'u-1' } })),
    ).resolves.toBe(true);
  });

  it('флаг выключен — 403 featureDisabled с причиной', async () => {
    const { guard } = makeGuard('checkout.new_flow', { enabled: false, reason: 'kill_switch' });
    const err = await guard
      .canActivate(makeContext({ user: { id: 'u-1' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    const response = (err as HttpException).getResponse() as Record<string, unknown>;
    expect(response).toMatchObject({
      statusCode: 403,
      code: 'featureDisabled',
      flag: 'checkout.new_flow',
      reason: 'kill_switch',
    });
  });

  it('сущность бакетинга: id из JWT → email из тела → ip', async () => {
    const { guard, seen } = makeGuard('checkout.new_flow', { enabled: true, reason: 'on' });

    await guard.canActivate(makeContext({ user: { id: 'u-1' }, body: { email: 'x@y.z' }, ip: '10.0.0.1' }));
    await guard.canActivate(makeContext({ body: { email: 'X@Y.Z' }, ip: '10.0.0.2' }));
    await guard.canActivate(makeContext({ ip: '10.0.0.3' }));

    expect(seen).toEqual([
      'checkout.new_flow|u-1',
      'checkout.new_flow|x@y.z', // email нормализуется, как у лимитов
      'checkout.new_flow|ip:10.0.0.3',
    ]);
  });
});

import { FlagsController } from './flags.controller';
import { FlagsEvaluator } from './flags.evaluator';
import type { FlagVerdict } from './bucketing';

/** Стаб вычислителя: запоминает, с чем спрашивали вердикт */
function makeController(verdict: FlagVerdict) {
  const asked: { key: string; entityId: string }[] = [];
  const evaluator = {
    async isEnabled(key: string, entityId: string): Promise<FlagVerdict> {
      asked.push({ key, entityId });
      return verdict;
    },
  } as unknown as FlagsEvaluator;
  return { controller: new FlagsController(evaluator), asked };
}

describe('FlagsController', () => {
  const me = { id: 'u-7', name: 'Алиса', email: 'a@b.c', role: 'user' as const };

  it('GET /:key — вердикт по id из JWT, процент наружу не идёт', async () => {
    const h = makeController({ enabled: true, reason: 'percentage', percentage: 40 });
    await expect(
      h.controller.verdict('checkout.new_flow', { user: me }),
    ).resolves.toEqual({
      key: 'checkout.new_flow',
      enabled: true,
      reason: 'percentage',
    });
    // та же сущность бакетинга, что у FeatureFlagGuard на маршруте:
    // кнопка на витрине и POST за ней не расходятся
    expect(h.asked).toEqual([
      { key: 'checkout.new_flow', entityId: 'u-7' },
    ]);
  });

  it('отсутствующий флаг — enabled=false (fail-safe витрины)', async () => {
    const h = makeController({ enabled: false, reason: 'not_found', percentage: 0 });
    await expect(
      h.controller.verdict('checkout.new_flow', { user: me }),
    ).resolves.toEqual({
      key: 'checkout.new_flow',
      enabled: false,
      reason: 'not_found',
    });
  });
});

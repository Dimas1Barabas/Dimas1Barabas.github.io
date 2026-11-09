import { FlagsController } from './flags.controller';
import { FlagsEvaluator } from './flags.evaluator';
import type { FlagVerdict } from './bucketing';

/** Стаб вычислителя: запоминает, с чем спрашивали вердикт и отчёты */
function makeController(verdict: FlagVerdict) {
  const asked: { key: string; entityId: string }[] = [];
  const exposures: { key: string; entityId: string }[] = [];
  const evaluator = {
    async isEnabled(key: string, entityId: string): Promise<FlagVerdict> {
      asked.push({ key, entityId });
      return verdict;
    },
    reportExposure(key: string, entityId: string): void {
      exposures.push({ key, entityId });
    },
  } as unknown as FlagsEvaluator;
  return { controller: new FlagsController(evaluator), asked, exposures };
}

describe('FlagsController', () => {
  const me = { id: 'u-7', name: 'Алиса', email: 'a@b.c', role: 'user' as const };

  it('GET /:key — вердикт по id из JWT, процент наружу не идёт', async () => {
    const h = makeController({
      enabled: true,
      reason: 'percentage',
      percentage: 40,
      variant: '',
    });
    await expect(
      h.controller.verdict('checkout.new_flow', { user: me }),
    ).resolves.toEqual({
      key: 'checkout.new_flow',
      enabled: true,
      reason: 'percentage',
      variant: '',
    });
    // та же сущность бакетинга, что у FeatureFlagGuard на маршруте:
    // кнопка на витрине и POST за ней не расходятся
    expect(h.asked).toEqual([
      { key: 'checkout.new_flow', entityId: 'u-7' },
    ]);
    // показ точки применения — экспозиция эксперимента той же сущностью
    expect(h.exposures).toEqual([
      { key: 'checkout.new_flow', entityId: 'u-7' },
    ]);
  });

  it('отсутствующий флаг — enabled=false (fail-safe витрины)', async () => {
    const h = makeController({
      enabled: false,
      reason: 'not_found',
      percentage: 0,
      variant: '',
    });
    await expect(
      h.controller.verdict('checkout.new_flow', { user: me }),
    ).resolves.toEqual({
      key: 'checkout.new_flow',
      enabled: false,
      reason: 'not_found',
      variant: '',
    });
    // экспозиция уходит и тут: вердикт «не показывать» — тоже показ
    // точки применения (база эксперимента); not_found сервис не посчитает
    expect(h.exposures).toHaveLength(1);
  });

  it('эксперимент: вердикт несёт вариант сущности', async () => {
    const h = makeController({
      enabled: true,
      reason: 'variant',
      percentage: 0,
      variant: 'b',
    });
    await expect(
      h.controller.verdict('booking.qr_v2', { user: me }),
    ).resolves.toEqual({
      key: 'booking.qr_v2',
      enabled: true,
      reason: 'variant',
      variant: 'b',
    });
  });
});

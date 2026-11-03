import { FlagsEvaluator } from './flags.evaluator';
import { FlagSnapshot } from './bucketing';
import { FLAG_CATALOG } from './flag-catalog';
import { UpsertFlagInput } from './flags.client';

/** Стаб gRPC-клиента: снимки из «сервиса», протокол саморегистрации */
function makeClient(
  snapshots: FlagSnapshot[],
  opts?: { fail?: boolean; upsertFail?: boolean },
) {
  const upserts: UpsertFlagInput[] = [];
  let fail = opts?.fail ?? false;
  return {
    upserts,
    setFail(value: boolean) {
      fail = value;
    },
    async listFlags(): Promise<FlagSnapshot[]> {
      if (fail) throw new Error('Суфлёр недоступен');
      return snapshots;
    },
    async upsertFlag(input: UpsertFlagInput): Promise<FlagSnapshot> {
      if (opts?.upsertFail) throw new Error('Суфлёр недоступен');
      upserts.push(input);
      snapshots = [...snapshots.filter((f) => f.key !== input.key), {
        ...input,
        updatedAt: '2026-11-02T12:00:00Z',
      }];
      return snapshots.find((f) => f.key === input.key)!;
    },
    async deleteFlag(): Promise<{ deleted?: boolean }> {
      return { deleted: true };
    },
    async evaluate(): Promise<{ enabled?: boolean }> {
      throw new Error('не используется: вердикты считает локальный кэш');
    },
  };
}

const flag = (over: Partial<FlagSnapshot>): FlagSnapshot => ({
  key: 'checkout.new_flow',
  description: '',
  enabled: true,
  percentage: 15,
  killed: false,
  updatedBy: 'qa',
  updatedAt: '2026-11-02T12:00:00Z',
  ...over,
});

describe('FlagsEvaluator', () => {
  beforeEach(() => {
    process.env.FLAGS_CACHE_TTL_MS = '0'; // каждый вызов — свежий опрос
  });
  afterEach(() => {
    delete process.env.FLAGS_CACHE_TTL_MS;
  });

  it('вердикты считает локально по снимку (user-2 внутри 15%, user-1 снаружи)', async () => {
    const client = makeClient([flag({})]);
    const evaluator = new FlagsEvaluator(client as never);
    await evaluator.onModuleInit();

    await expect(evaluator.isEnabled('checkout.new_flow', 'user-2')).resolves.toMatchObject({
      enabled: true,
      reason: 'percentage',
    });
    await expect(evaluator.isEnabled('checkout.new_flow', 'user-1')).resolves.toMatchObject({
      enabled: false,
      reason: 'percentage',
    });
  });

  it('kill-switch из свежего снимка применяется следующим вердиктом', async () => {
    const client = makeClient([flag({})]);
    const evaluator = new FlagsEvaluator(client as never);
    await evaluator.onModuleInit();

    // сервис переключил kill-switch: следующий опрос приносит новый снимок
    await client.upsertFlag({
      key: 'checkout.new_flow', description: '', enabled: true,
      percentage: 100, killed: true, updatedBy: 'admin',
    });
    // тик времени: TTL=0 сравнивает миллисекунды, в одной не сработает
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(evaluator.isEnabled('checkout.new_flow', 'user-2')).resolves.toMatchObject({
      enabled: false,
      reason: 'kill_switch',
    });
  });

  it('list() по истечении TTL сам обновляет кэш (админка видит свежее)', async () => {
    const client = makeClient([flag({})]);
    const evaluator = new FlagsEvaluator(client as never);
    await evaluator.onModuleInit();

    await client.upsertFlag({
      key: 'checkout.new_flow', description: '', enabled: true,
      percentage: 25, killed: false, updatedBy: 'admin',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const list = await evaluator.list(); // TTL истёк — refresh внутри list()
    expect(list.find((f) => f.key === 'checkout.new_flow')?.percentage).toBe(25);
  });

  it('сбой саморегистрации не валит кэш: известные флаги остаются', async () => {
    // сервис знает один флаг, но правки не принимает (например, read-only)
    const client = makeClient([flag({})], { upsertFail: true });
    const evaluator = new FlagsEvaluator(client as never);
    await evaluator.onModuleInit(); // каждый upsert каталога упал — не страшно

    const list = await evaluator.list();
    expect(list.map((f) => f.key)).toEqual(['checkout.new_flow']);
    expect(client.upserts).toEqual([]); // ни одна правка не дошла до счётчика
  });

  it('саморегистрация: флаг каталога, которого нет в сервисе, создаётся', async () => {
    const client = makeClient([]); // сервис пуст — все флаги каталога новые
    const evaluator = new FlagsEvaluator(client as never);
    await evaluator.onModuleInit();

    expect(client.upserts.map((u) => u.key).sort()).toEqual(
      FLAG_CATALOG.map((c) => c.key).sort(),
    );
    const list = await evaluator.list();
    expect(list.map((f) => f.key).sort()).toEqual(
      FLAG_CATALOG.map((c) => c.key).sort(),
    );
  });

  it('недоступность сервиса — вердикты по последнему снимку (fail-safe)', async () => {
    const client = makeClient([flag({})]);
    const evaluator = new FlagsEvaluator(client as never);
    await evaluator.onModuleInit();

    client.setFail(true);
    // TTL=0 → опрос, он упал → остаёмся на прошлом снимке
    await expect(evaluator.isEnabled('checkout.new_flow', 'user-2')).resolves.toMatchObject({
      enabled: true,
      reason: 'percentage',
    });
  });

  it('нет флага ни в кэше, ни в каталоге — not_found, фича скрыта', async () => {
    const client = makeClient([flag({})]);
    const evaluator = new FlagsEvaluator(client as never);
    await evaluator.onModuleInit();

    await expect(evaluator.isEnabled('no.such_flag', 'user-1')).resolves.toMatchObject({
      enabled: false,
      reason: 'not_found',
    });
  });

  it('сбой onModuleInit не валит старт API', async () => {
    const client = makeClient([], { fail: true });
    const evaluator = new FlagsEvaluator(client as never);
    await expect(evaluator.onModuleInit()).resolves.toBeUndefined();
  });
});

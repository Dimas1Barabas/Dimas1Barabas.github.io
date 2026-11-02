import { HttpException } from '@nestjs/common';
import { FlagsAdminController } from './flags-admin.controller';
import { FlagsEvaluator } from './flags.evaluator';
import { FlagsClient, UpsertFlagInput } from './flags.client';
import { FlagsRevisionsClient } from './flags-revisions.client';
import { FlagSnapshot } from './bucketing';

const snap: FlagSnapshot = {
  key: 'checkout.new_flow',
  description: 'новый чекаут',
  enabled: true,
  percentage: 15,
  killed: false,
  updatedBy: 'qa',
  updatedAt: '2026-11-02T12:00:00Z',
};

/** Стабы: клиент сервиса + кэш + HTTP-витрина аудита */
function makeController(opts?: { failUpsert?: boolean }) {
  const upserts: UpsertFlagInput[] = [];
  let deleted: string | null = null;
  const client = {
    async upsertFlag(input: UpsertFlagInput): Promise<FlagSnapshot> {
      if (opts?.failUpsert) throw new Error('/grpc:14 unavailable');
      upserts.push(input);
      return { ...snap, ...input, updatedAt: '2026-11-02T12:01:00Z' };
    },
    async deleteFlag(key: string): Promise<{ deleted?: boolean }> {
      deleted = key;
      return { deleted: true };
    },
  } as unknown as FlagsClient;

  let refreshed = 0;
  const evaluator = {
    async list() {
      return [snap];
    },
    async refresh() {
      refreshed += 1;
    },
  } as unknown as FlagsEvaluator;

  const revisions = {
    async revisions(key: string) {
      return [
        { key, changedBy: 'admin', changedAt: '2026-11-02T12:01:00Z', snapshot: { enabled: true, percentage: 15, killed: false } },
      ];
    },
  } as unknown as FlagsRevisionsClient;

  return {
    controller: new FlagsAdminController(evaluator, client, revisions),
    upserts,
    get deleted() {
      return deleted;
    },
    get refreshed() {
      return refreshed;
    },
  };
}

describe('FlagsAdminController', () => {
  const admin = { id: 'u-9', name: 'Админ', email: 'admin@cine.local', role: 'admin' as const };

  it('GET / — витрина снимков из кэша', async () => {
    const { controller } = makeController();
    await expect(controller.list()).resolves.toEqual({ flags: [snap] });
  });

  it('PATCH /:key — правка от имени админа + инвалидация кэша', async () => {
    const h = makeController();
    const res = await h.controller.upsert(
      'checkout.new_flow',
      { description: 'новый чекаут', enabled: true, percentage: 40, killed: false },
      { user: admin },
    );
    expect(h.upserts).toEqual([
      {
        key: 'checkout.new_flow',
        description: 'новый чекаут',
        enabled: true,
        percentage: 40,
        killed: false,
        updatedBy: 'admin@cine.local', // аудит видит автора правки
      },
    ]);
    expect(res.percentage).toBe(40);
    expect(h.refreshed).toBe(1); // кэш не ждёт TTL после правки
  });

  it('PATCH /:key при сбое сервиса — 502, кэш не трогаем', async () => {
    const { controller } = makeController({ failUpsert: true });
    await expect(
      controller.upsert(
        'checkout.new_flow',
        { description: '', enabled: true, percentage: 0, killed: true },
        { user: admin },
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('DELETE /:key — удаление + инвалидация кэша', async () => {
    const h = makeController();
    await expect(h.controller.remove('checkout.new_flow')).resolves.toEqual({ deleted: true });
    expect(h.deleted).toBe('checkout.new_flow');
    expect(h.refreshed).toBe(1);
  });

  it('GET /:key/revisions — аудит из витрины сервиса', async () => {
    const { controller } = makeController();
    const res = await controller.history('checkout.new_flow');
    expect(res.revisions).toHaveLength(1);
    expect(res.revisions[0]).toMatchObject({ changedBy: 'admin' });
  });
});

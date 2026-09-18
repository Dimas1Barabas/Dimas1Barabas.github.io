import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { Promo } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { usePromosStore } from '@/entities/promo/model/promos.store';

vi.mock('@/shared/api/client', async (importOriginal) => {
  // ApiError оставляем настоящим; мокаем только сеть
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      adminPromos: vi.fn(),
      createPromo: vi.fn(),
    },
  };
});

const promoFixture = (overrides: Partial<Promo> = {}): Promo => ({
  id: 'p-1',
  code: 'LIVE10',
  kind: 'percent',
  value: 10,
  maxActivations: 50,
  usedCount: 7,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('promos store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    demoEngine.reset();
    vi.mocked(api.adminPromos).mockReset();
    vi.mocked(api.createPromo).mockReset();
  });

  it('демо: сиды промокодов свежими копиями', async () => {
    useAppStore().mode = 'demo';

    const store = usePromosStore();
    await store.refresh();

    const codes = store.promos.map((p) => p.code);
    expect(codes).toEqual(
      expect.arrayContaining(['CINE10', 'SUMMER300', 'EXPIRED5']),
    );
    // копии: мутация стора не трогает движок
    store.promos[0]!.code = 'HACKED';
    expect(demoEngine.listPromos()[0]!.code).not.toBe('HACKED');
  });

  it('демо: create через движок, список обновляется', async () => {
    useAppStore().mode = 'demo';

    const store = usePromosStore();
    await store.refresh();

    const created = await store.create({
      code: 'newcode',
      kind: 'fixed',
      value: 150,
      maxActivations: 5,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(created.code).toBe('NEWCODE');
    expect(store.promos.some((p) => p.code === 'NEWCODE')).toBe(true);
  });

  it('демо: дубль кода — ApiError наружу, состояние не ломается', async () => {
    useAppStore().mode = 'demo';

    const store = usePromosStore();
    await store.refresh();

    await expect(
      store.create({
        code: 'cine10',
        kind: 'percent',
        value: 10,
        maxActivations: 5,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toThrowError(expect.objectContaining({ status: 409 }));
    expect(store.error).toBeNull();
  });

  it('live: список и создание — через API', async () => {
    useAppStore().mode = 'live';
    const list = [promoFixture()];
    vi.mocked(api.adminPromos).mockResolvedValue(list);
    vi.mocked(api.createPromo).mockResolvedValue(
      promoFixture({ id: 'p-2', code: 'LIVE300', kind: 'fixed', value: 300 }),
    );

    const store = usePromosStore();
    await store.refresh();
    expect(store.promos).toEqual(list);

    const created = await store.create({
      code: 'live300',
      kind: 'fixed',
      value: 300,
      maxActivations: 10,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(api.createPromo).toHaveBeenCalledTimes(1);
    expect(created.code).toBe('LIVE300');
    expect(store.loading).toBe(false);
  });

  it('live: ошибка загрузки — текст в state, без броска', async () => {
    useAppStore().mode = 'live';
    vi.mocked(api.adminPromos).mockRejectedValue(new Error('offline'));

    const store = usePromosStore();
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.error).toBe('offline');
  });
});

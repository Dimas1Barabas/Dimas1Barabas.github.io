import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { demoEngine } from '@/shared/api/demo-engine';
import type { AdminStatsEnvelope } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useStatsStore } from '@/entities/stats/model/store';

/** стор админ-аналитики: live-запрос и демо-ветка движка */

vi.mock('@/shared/api/client', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    api: { adminStats: vi.fn() },
  };
});

import { api } from '@/shared/api/client';

const adminStatsMock = vi.mocked(api.adminStats);

function envelope(data: AdminStatsEnvelope['data']): AdminStatsEnvelope {
  return { source: 'db', data };
}

describe('stores/stats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    demoEngine.reset();
    adminStatsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('demo: агрегаты движка с копиями и «кэшем» 30 c', () => {
    useAppStore().mode = 'demo';
    const store = useStatsStore();

    store.refresh();

    expect(store.admin).not.toBeNull();
    expect(store.admin!.totals.bookingsTotal).toBe(demoEngine.list().length);
    expect(store.source).toBe('db');
    expect(store.error).toBeNull();
    expect(store.lastUpdated).not.toBeNull();

    // движок отдаёт копии: выдачи не делят объекты с его кэшем
    const first = store.admin;
    store.refresh();
    expect(store.source).toBe('cache');
    expect(store.admin).not.toBe(first);
    expect(store.admin!.totals).toEqual(first!.totals);
  });

  it('live: запрос за Bearer и раскладка конверта', async () => {
    useAppStore().mode = 'live';
    const store = useStatsStore();
    const payload = envelope({
      totals: {
        bookingsTotal: 5,
        confirmed: 3,
        revenueRub: 4800,
        avgTicketRub: 1600,
        seatsSold: 4,
        upcomingOccupancyPct: 13,
        moviesCount: 2,
        reviewsCount: 2,
        avgRating: 4.5,
      },
      byStatus: {
        PENDING_PAYMENT: 1,
        PENDING: 0,
        CONFIRMED: 3,
        FAILED: 0,
        EXPIRED: 1,
        CANCELLING: 0,
        CANCELLED: 0,
      },
      topMovies: [],
      upcomingSessions: [],
      revenueByDay: [],
    });
    adminStatsMock.mockResolvedValue(payload);

    await store.refresh();

    expect(adminStatsMock).toHaveBeenCalledTimes(1);
    expect(store.admin).toEqual(payload.data);
    expect(store.source).toBe('db');
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it('live: ошибка запроса — сообщение, данные не трогаем', async () => {
    useAppStore().mode = 'live';
    const store = useStatsStore();
    adminStatsMock.mockRejectedValue(new Error('HTTP 403'));

    await store.refresh();

    expect(store.error).toBe('HTTP 403');
    expect(store.admin).toBeNull();
    expect(store.loading).toBe(false);
  });
});

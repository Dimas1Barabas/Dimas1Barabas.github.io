import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/shared/api/app-mode';
import { demoEngine } from '@/shared/api/demo-engine';
import type { BehaviorInsightsEnvelope } from '@/shared/api/types';
import { useBehaviorStore } from './store';

/**
 * Стор витрины «Поведение»: live — конверт прокси (available/data),
 * демо — детерминированные числа движка.
 */

const liveResponse: BehaviorInsightsEnvelope = {
  available: true,
  data: {
    funnel: [{ step: 'paid', count: 3 }],
    movies: [{ movieId: 'm-1', opens: 10, bookings: 2, conversionPercent: 20 }],
    pages: [{ route: 'home', views: 5, avgDwellMs: 4000 }],
    seats: [{ hall: 'Красный', seat: '5-7', clicks: 4 }],
    modal: [{ deepest: 'seats', events: 2, avgMs: 52000 }],
  },
};

describe('useBehaviorStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('live: конверт прокси раскладывается в insights+available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(liveResponse))),
    );
    useAppStore().mode = 'live';

    const store = useBehaviorStore();
    await store.refresh();

    expect(store.available).toBe(true);
    expect(store.insights?.funnel).toEqual([{ step: 'paid', count: 3 }]);
    expect(store.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('live: Аналитик недоступен — available:false, данных нет, ошибки нет', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ available: false }))),
    );
    useAppStore().mode = 'live';

    const store = useBehaviorStore();
    await store.refresh();

    expect(store.available).toBe(false);
    expect(store.insights).toBeNull();
    expect(store.error).toBeNull();
    vi.unstubAllGlobals();
  });

  it('демо: числа движка, конверсия в разумных рамках', async () => {
    useAppStore().mode = 'demo';
    const store = useBehaviorStore();
    await store.refresh();

    expect(store.available).toBe(true);
    expect(store.insights).not.toBeNull();
    for (const m of store.insights!.movies) {
      expect(m.opens).toBeGreaterThan(0);
      expect(m.bookings).toBeGreaterThan(0);
      expect(m.conversionPercent).toBeGreaterThanOrEqual(0);
      expect(m.conversionPercent).toBeLessThanOrEqual(100);
    }
    // воронка монотонна до paid
    const modalOpens = store.insights!.funnel.find((f) => f.step === 'modal_open');
    const paid = store.insights!.funnel.find((f) => f.step === 'paid');
    expect(paid!.count).toBeLessThan(modalOpens!.count);
  });

  it('демо-движок детерминирован: два вызова дают одинаковые цифры', () => {
    const a = demoEngine.behaviorInsights();
    const b = demoEngine.behaviorInsights();
    expect(a).toEqual(b);
  });
});

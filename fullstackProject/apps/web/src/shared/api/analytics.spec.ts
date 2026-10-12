import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDwellClock,
  enterRoute,
  flush,
  initAnalytics,
  resetAnalyticsForTests,
  setAnalyticsUser,
  trackAnalytics,
} from './analytics';
import { apiUrl } from './client';

/**
 * Трекер поведения: буферизация до инициализации, батчи с конвертом
 * aid/userId, no-op демо-режима, активное время пребывания (фон вкладки
 * часы останавливает). fetch мокается — сеть в юнит-тестах не ходит.
 */

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) => new Response('{}'),
);

function lastBatch(): { aid: string; userId?: string; events: unknown[] } {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse(String(call?.[1]?.body)) as {
    aid: string;
    userId?: string;
    events: unknown[];
  };
}

beforeEach(() => {
  resetAnalyticsForTests();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { ...crypto, randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('инициализация и режимы', () => {
  it('до инициализации события буферизуются, отправки нет', () => {
    trackAnalytics('page_view', { route: 'home' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('live: буфер уходит первым флашем с конвертом aid', () => {
    trackAnalytics('page_view', { route: 'home' });
    initAnalytics(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const batch = lastBatch();
    expect(batch.aid).toBe('11111111-1111-4111-8111-111111111111');
    expect(batch.events).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(apiUrl('/analytics/events'));
  });

  it('демо: очередь сбрасывается, события не уходят', () => {
    trackAnalytics('page_view', { route: 'home' });
    initAnalytics(false);
    trackAnalytics('seat_click', { sessionId: 's', hall: 'h', seat: '1-1' });
    flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aid сохраняется в localStorage между инициализациями', () => {
    initAnalytics(true);
    expect(localStorage.getItem('cine.aid')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});

describe('идентичность', () => {
  it('userId появляется в батче после входа', () => {
    initAnalytics(true);
    setAnalyticsUser('22222222-2222-4222-8222-222222222222');
    trackAnalytics('booking_modal_open', { movieId: 'm-1' });
    flush();
    expect(lastBatch().userId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('выход досылает события прежней личности без нового userId', () => {
    initAnalytics(true);
    setAnalyticsUser('22222222-2222-4222-8222-222222222222');
    trackAnalytics('page_view', { route: 'home' });
    setAnalyticsUser(null); // выход: сначала флаш, потом смена
    trackAnalytics('page_view', { route: 'login' });
    flush();

    const withUser = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const anonymous = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(withUser.userId).toBe('22222222-2222-4222-8222-222222222222');
    expect(anonymous.userId).toBeUndefined();
  });
});

describe('маршруты и время пребывания', () => {
  it('смена маршрута закрывает dwell предыдущего и открывает page_view', () => {
    vi.useFakeTimers();
    initAnalytics(true);
    fetchMock.mockClear();

    enterRoute('home');
    vi.advanceTimersByTime(5000);
    enterRoute('bookings');
    flush();

    const batch = lastBatch();
    const types = batch.events.map((e) => (e as { type: string }).type);
    expect(types).toContain('page_view');
    expect(types).toContain('page_dwell');

    const dwell = batch.events.find(
      (e) => (e as { type: string }).type === 'page_dwell',
    ) as { route: string; ms: number };
    expect(dwell.route).toBe('home');
    expect(dwell.ms).toBeGreaterThanOrEqual(5000);
    vi.useRealTimers();
  });

  it('фон вкладки останавливает часы активного времени', () => {
    vi.useFakeTimers();
    let hidden = false;
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => (hidden ? 'hidden' : 'visible'));

    const clock = createDwellClock();
    vi.advanceTimersByTime(3000);

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(10000); // в фоне — не считается

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(2000);

    const active = clock.stop();
    expect(active).toBeGreaterThanOrEqual(5000);
    expect(active).toBeLessThan(5500);
    visibilitySpy.mockRestore();
    vi.useRealTimers();
  });
});

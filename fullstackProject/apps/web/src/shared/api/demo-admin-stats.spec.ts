/**
 * Демо-движок: аналитика сидов — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { HALL_CAPACITY } from '@/shared/lib/hall';
import { CLEAN_MOVIE } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: аналитика сидов', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('сид-брони: табло непустое, статусы терминальные, владельцы чужие', () => {
    const list = demoEngine.list();
    expect(list.length).toBeGreaterThanOrEqual(10);
    // сиды — «другие зрители»: гость не владеет ими (право отзыва не даётся)
    for (const b of list) {
      expect(b.userId).not.toBeNull();
      expect(b.processedBy).toBe('go-worker (демо)');
    }

    const stats = demoEngine.stats();
    const sum = Object.values(stats).reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(list.length);
    expect(stats.CONFIRMED).toBeGreaterThan(0); // выручке есть из чего браться
  });

  it('canReview: CONFIRMED-сиды чужих зрителей права не дают', () => {
    // у cache-lady есть CONFIRMED-сид, но гость на фильм не ходил
    expect(demoEngine.canReview(CLEAN_MOVIE)).toBe(false);
  });

  it('adminStats: сводка и топ сходятся с сидами; конверт source=db', () => {
    const { source, data } = demoEngine.adminStats();

    expect(source).toBe('db');
    const list = demoEngine.list();
    const confirmed = list.filter((b) => b.status === 'CONFIRMED');
    expect(data.totals.bookingsTotal).toBe(list.length);
    expect(data.totals.confirmed).toBe(confirmed.length);
    expect(data.totals.revenueRub).toBe(
      confirmed.reduce((acc, b) => acc + b.totalRub, 0),
    );
    expect(data.totals.moviesCount).toBe(6);
    expect(data.totals.reviewsCount).toBe(4); // сид-отзывы

    // все 7 статусов, сумма счётчиков — всей истории
    expect(Object.keys(data.byStatus)).toHaveLength(7);
    const sum = Object.values(data.byStatus).reduce((acc, n) => acc + n, 0);
    expect(sum).toBe(list.length);

    // топ возглавляет «Млечный Путь»: 4 брони, 9 мест, 4050 ₽
    expect(data.topMovies).toHaveLength(5);
    expect(data.topMovies[0]).toMatchObject({
      movieId: 'demo-milky-way',
      title: 'Млечный Путь: Операция «Туманность»',
      bookings: 4,
      seats: 9,
      revenueRub: 4050,
    });
  });

  it('adminStats: предстоящие сеансы по времени, занятость не ниже сид-мест', () => {
    const { data } = demoEngine.adminStats();

    const times = data.upcomingSessions.map((s) => Date.parse(s.startsAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(data.upcomingSessions.length).toBeLessThanOrEqual(8);

    // CONFIRMED-сиды держат места своих сеансов (как seat_occupancy)
    const seedSeats = new Map<string, number>();
    for (const b of demoEngine.list()) {
      if (b.status === 'CONFIRMED') {
        seedSeats.set(
          b.sessionId,
          (seedSeats.get(b.sessionId) ?? 0) + b.seats.length,
        );
      }
    }
    expect(data.upcomingSessions.length).toBeGreaterThan(0);
    for (const s of data.upcomingSessions) {
      expect(s.capacity).toBe(HALL_CAPACITY);
      expect(s.occupied).toBeGreaterThanOrEqual(seedSeats.get(s.sessionId) ?? 0);
      expect(s.occupancyPct).toBe(Math.round((s.occupied / s.capacity) * 100));
    }
  });

  it('adminStats: график — 14 дней подряд, сумма столбцов равна выручке', () => {
    const { data } = demoEngine.adminStats();

    expect(data.revenueByDay).toHaveLength(14);
    for (let i = 1; i < data.revenueByDay.length; i++) {
      expect(
        Date.parse(data.revenueByDay[i].day) - Date.parse(data.revenueByDay[i - 1].day),
      ).toBe(24 * 3600_000);
    }
    const sum = data.revenueByDay.reduce((acc, d) => acc + d.revenueRub, 0);
    expect(sum).toBe(data.totals.revenueRub); // все сиды попадают в окно
  });

  it('adminStats: кэш 30 c — повторный из кэша, по TTL и reset — пересчёт', () => {
    const first = demoEngine.adminStats();
    expect(first.source).toBe('db');

    const second = demoEngine.adminStats();
    expect(second.source).toBe('cache');
    expect(second.data.totals).toEqual(first.data.totals);

    // копии: выдачи не делят объекты (движок вне реактивности Vue)
    expect(second.data).not.toBe(first.data);

    // окно кэша истекло — пересчёт
    vi.advanceTimersByTime(31_000);
    expect(demoEngine.adminStats().source).toBe('db');

    // сброс состояния обнуляет кэш аналитики
    demoEngine.reset();
    expect(demoEngine.adminStats().source).toBe('db');
  });

});

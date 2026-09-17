import { describe, expect, it } from 'vitest';
import type { Booking } from '@/shared/api/types';
import {
  REVENUE_DAYS,
  adminTotals,
  countByStatus,
  dayKey,
  ratingAgg,
  revenueByDay,
  sessionOccupancy,
  topMovies,
} from '@/shared/lib/admin-stats';

/** агрегаты админ-аналитики — зеркало admin-stats.logic.ts в API */

function booking(partial: Partial<Booking>): Booking {
  return {
    id: 'b-1',
    movieId: 'm-1',
    movieTitle: 'Фильм',
    movieHue: 200,
    movieGenreIcon: '🎟️',
    sessionId: 's-1',
    sessionAt: '2026-09-20T10:00:00.000Z',
    hall: 'IMAX',
    customerName: 'Гость',
    userId: null,
    seats: ['5-7'],
    totalRub: 1000,
    status: 'CONFIRMED',
    expiresAt: null,
    message: null,
    processedBy: null,
    processedAt: null,
    createdAt: '2026-09-16T10:00:00.000Z',
    ...partial,
  } as Booking;
}

describe('dayKey', () => {
  it('локальный день с ведущими нулями', () => {
    expect(dayKey(new Date(2026, 8, 16, 23, 59))).toBe('2026-09-16');
    expect(dayKey(new Date(2026, 8, 5))).toBe('2026-09-05');
  });
});

describe('countByStatus', () => {
  it('все 7 ключей, отсутствующие — нули', () => {
    const counts = countByStatus([
      booking({ status: 'CONFIRMED' }),
      booking({ status: 'EXPIRED' }),
    ]);
    expect(Object.keys(counts)).toHaveLength(7);
    expect(counts.CONFIRMED).toBe(1);
    expect(counts.CANCELLING).toBe(0);
  });
});

describe('revenueByDay', () => {
  const now = new Date(2026, 8, 16, 12, 0);

  it('окно 14 дней включая сегодня; переход месяца не ломает ключи', () => {
    const days = revenueByDay([], now);
    expect(days).toHaveLength(REVENUE_DAYS);
    expect(days[0].day).toBe('2026-09-03');
    expect(days[REVENUE_DAYS - 1].day).toBe('2026-09-16');

    const monthEdge = revenueByDay([], new Date(2026, 8, 1));
    expect(monthEdge[0].day).toBe('2026-08-19');
  });

  it('день вердикта важнее создания; не-CONFIRMED не считаются', () => {
    const days = revenueByDay(
      [
        booking({
          createdAt: '2026-09-13T18:00:00',
          processedAt: '2026-09-15T09:00:00',
          totalRub: 1200,
        }),
        booking({ status: 'CANCELLED', totalRub: 5000 }),
      ],
      now,
    );
    expect(days[REVENUE_DAYS - 2]).toMatchObject({
      day: '2026-09-15',
      bookings: 1,
      revenueRub: 1200,
    });
    expect(days[REVENUE_DAYS - 1]).toMatchObject({ bookings: 0, revenueRub: 0 });
  });

  it('брони одного дня суммируются', () => {
    const days = revenueByDay(
      [
        booking({ totalRub: 1000, createdAt: '2026-09-16T10:00:00' }),
        booking({ totalRub: 800, createdAt: '2026-09-16T20:00:00' }),
      ],
      now,
    );
    expect(days[REVENUE_DAYS - 1]).toMatchObject({ bookings: 2, revenueRub: 1800 });
  });
});

describe('topMovies', () => {
  it('сортировка по броням, ничья по выручке, limit режет', () => {
    const rows = [
      booking({ movieId: 'a', totalRub: 500 }),
      booking({ movieId: 'b', totalRub: 3000 }),
      booking({ movieId: 'b', totalRub: 4000 }),
      booking({ movieId: 'c', status: 'EXPIRED', totalRub: 9999 }),
    ];
    const top = topMovies(rows, new Map([['a', 'А'], ['b', 'Б']]), 5);

    expect(top).toHaveLength(2); // EXPIRED не в топе
    expect(top[0]).toMatchObject({ movieId: 'b', bookings: 2, revenueRub: 7000 });
    expect(top[1]).toMatchObject({ movieId: 'a', bookings: 1, revenueRub: 500 });
  });
});

describe('sessionOccupancy', () => {
  it('проценты, средняя и limit', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      id: `s-${i}`,
      movieTitle: `Фильм ${i}`,
      hall: 'IMAX',
      startsAt: new Date(2026, 8, 20, 10 + i),
    }));
    const occupied = new Map([
      ['s-0', 40],
      ['s-1', 20],
    ]);

    const { list, avgPct } = sessionOccupancy(sessions, occupied, 8);

    expect(list).toHaveLength(8);
    expect(list[0]).toMatchObject({ occupied: 40, capacity: 80, occupancyPct: 50 });
    // среднее по всем 10: (50 + 25) / 10
    expect(avgPct).toBe(8);
  });

  it('без сеансов — ноль', () => {
    expect(sessionOccupancy([], new Map())).toEqual({ list: [], avgPct: 0 });
  });
});

describe('ratingAgg', () => {
  it('пусто — нули; округление до сотых', () => {
    expect(ratingAgg([])).toEqual({ count: 0, avg: 0 });
    expect(ratingAgg([{ rating: 4 }, { rating: 5 }, { rating: 4 }])).toEqual({
      count: 3,
      avg: 4.33,
    });
  });
});

describe('adminTotals', () => {
  it('выручка и чек по CONFIRMED; без продаж — нули', () => {
    const result = adminTotals(
      [
        booking({ totalRub: 1000, seats: ['1-1', '1-2'] }),
        booking({ totalRub: 999 }),
        booking({ status: 'CANCELLED', totalRub: 5000 }),
      ],
      { moviesCount: 6, reviewsCount: 3, avgRating: 4.5, upcomingAvgPct: 34 },
    );
    expect(result).toMatchObject({
      bookingsTotal: 3,
      confirmed: 2,
      revenueRub: 1999,
      avgTicketRub: 1000, // round(999.5)
      seatsSold: 3,
      upcomingOccupancyPct: 34,
    });

    const empty = adminTotals([], {
      moviesCount: 0,
      reviewsCount: 0,
      avgRating: 0,
      upcomingAvgPct: 0,
    });
    expect(empty.avgTicketRub).toBe(0);
    expect(empty.revenueRub).toBe(0);
  });
});

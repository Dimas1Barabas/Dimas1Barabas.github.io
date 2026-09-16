import { BookingStatus } from '../bookings/booking.entity';
import {
  BookingFact,
  REVENUE_DAYS,
  countByStatus,
  dayKey,
  ratingAgg,
  revenueByDay,
  topMovies,
  totals,
  upcomingOccupancy,
} from './admin-stats.logic';

/** бронь-заготовка: всё дефолтное, тест подменяет нужное */
function fact(partial: Partial<BookingFact>): BookingFact {
  return {
    status: 'CONFIRMED',
    totalRub: 1000,
    seats: ['5-7'],
    movieId: 'movie-1',
    createdAt: new Date(),
    processedAt: null,
    ...partial,
  };
}

describe('dayKey', () => {
  it('локальный день с ведущими нулями', () => {
    expect(dayKey(new Date(2026, 8, 16, 23, 59))).toBe('2026-09-16');
    expect(dayKey(new Date(2026, 8, 5))).toBe('2026-09-05');
  });
});

describe('countByStatus', () => {
  it('все 7 статусов на месте, отсутствующие — нули', () => {
    const counts = countByStatus([
      fact({ status: 'CONFIRMED' }),
      fact({ status: 'CONFIRMED' }),
      fact({ status: 'EXPIRED' }),
    ]);

    expect(Object.keys(counts)).toHaveLength(7);
    expect(counts.CONFIRMED).toBe(2);
    expect(counts.EXPIRED).toBe(1);
    expect(counts.PENDING_PAYMENT).toBe(0);
    expect(counts.CANCELLING).toBe(0);
    expect(counts.CANCELLED).toBe(0);
  });

  it('пустая выгрузка — нули', () => {
    const counts = countByStatus([]);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe('revenueByDay', () => {
  const now = new Date(2026, 8, 16, 12, 0);

  it('окно 14 дней включая сегодня, пустые — нули', () => {
    const days = revenueByDay([], now);

    expect(days).toHaveLength(REVENUE_DAYS);
    expect(days[0].day).toBe('2026-09-03');
    expect(days[REVENUE_DAYS - 1].day).toBe('2026-09-16');
    expect(days.every((d) => d.bookings === 0 && d.revenueRub === 0)).toBe(true);
  });

  it('переход месяца не ломает ключи', () => {
    const days = revenueByDay([], new Date(2026, 8, 1));
    expect(days[0].day).toBe('2026-08-19');
    expect(days[REVENUE_DAYS - 1].day).toBe('2026-09-01');
  });

  it('день вердикта важнее дня создания, не-CONFIRMED не считаются', () => {
    const days = revenueByDay(
      [
        // создана 3 дня назад, подтверждена вчера → столбец «вчера»
        fact({
          createdAt: new Date(2026, 8, 13, 18, 0),
          processedAt: new Date(2026, 8, 15, 9, 0),
          totalRub: 1200,
        }),
        // ещё не подтверждена — в выручке её нет
        fact({ status: 'PENDING_PAYMENT' }),
        fact({ status: 'CANCELLED' }),
      ],
      now,
    );

    const yesterday = days[REVENUE_DAYS - 2];
    const today = days[REVENUE_DAYS - 1];
    expect(yesterday).toMatchObject({ day: '2026-09-15', bookings: 1, revenueRub: 1200 });
    expect(today).toMatchObject({ day: '2026-09-16', bookings: 0, revenueRub: 0 });
  });

  it('несколько броней одного дня суммируются', () => {
    const days = revenueByDay(
      [
        fact({ totalRub: 1000, createdAt: new Date(2026, 8, 16, 10, 0) }),
        fact({ totalRub: 800, createdAt: new Date(2026, 8, 16, 20, 0) }),
      ],
      now,
    );

    expect(days[REVENUE_DAYS - 1]).toMatchObject({
      bookings: 2,
      revenueRub: 1800,
    });
  });

  it('полуночная продажа остаётся в своём локальном дне', () => {
    const days = revenueByDay(
      [fact({ createdAt: new Date(2026, 8, 16, 0, 5) })],
      now,
    );
    expect(days[REVENUE_DAYS - 1].bookings).toBe(1);
  });
});

describe('topMovies', () => {
  it('сортировка по подтверждённым броням, ничья — по выручке', () => {
    const rows = [
      fact({ movieId: 'a', totalRub: 500 }),
      fact({ movieId: 'a', totalRub: 500, seats: ['5-7', '5-8'] }),
      fact({ movieId: 'b', totalRub: 3000 }),
      fact({ movieId: 'b', totalRub: 4000 }),
      fact({ movieId: 'b', totalRub: 5000 }),
      fact({ movieId: 'c', status: 'EXPIRED', totalRub: 9999 }),
    ];
    const titles = new Map([
      ['a', 'Фильм А'],
      ['b', 'Фильм Б'],
    ]);

    const top = topMovies(rows, titles);

    expect(top).toHaveLength(2); // EXPIRED-брони фильма c не считаются
    expect(top[0]).toMatchObject({
      movieId: 'b',
      title: 'Фильм Б',
      bookings: 3,
      seats: 3,
      revenueRub: 12000,
    });
    expect(top[1]).toMatchObject({ movieId: 'a', bookings: 2, seats: 3, revenueRub: 1000 });
  });

  it('не больше limit строк, неизвестный фильм — прочерк', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((movieId, i) =>
      fact({ movieId, totalRub: 100 * (6 - i) }),
    );

    const top = topMovies(rows, new Map(), 5);

    expect(top).toHaveLength(5);
    expect(top.every((t) => t.title === '—')).toBe(true);
  });
});

describe('upcomingOccupancy', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => ({
    id: `s-${i}`,
    movieTitle: `Фильм ${i}`,
    hall: 'IMAX',
    startsAt: new Date(2026, 8, 20, 10 + i),
  }));

  it('список режется до limit, проценты округляются', () => {
    const occupied = new Map([
      ['s-0', 40], // 50%
      ['s-1', 20], // 25%
    ]);

    const { list, avgPct } = upcomingOccupancy(sessions, occupied, 8);

    expect(list).toHaveLength(8);
    expect(list[0]).toMatchObject({
      sessionId: 's-0',
      occupied: 40,
      capacity: 80,
      occupancyPct: 50,
    });
    expect(list[1].occupancyPct).toBe(25);
    // среднее по всем 10 сеансам, не по первой восьмёрке: (50+25)/10 = 7.5 → 8
    expect(avgPct).toBe(8);
  });

  it('без предстоящих сеансов средняя заполняемость — ноль', () => {
    expect(upcomingOccupancy([], new Map())).toEqual({ list: [], avgPct: 0 });
  });
});

describe('ratingAgg', () => {
  it('пусто — нули', () => {
    expect(ratingAgg([])).toEqual({ count: 0, avg: 0 });
  });

  it('округление до сотых', () => {
    expect(ratingAgg([{ rating: 4 }, { rating: 5 }, { rating: 4 }])).toEqual({
      count: 3,
      avg: 4.33,
    });
  });
});

describe('totals', () => {
  it('сводка по подтверждённым, средний чек с округлением', () => {
    const result = totals(
      [
        fact({ totalRub: 1000, seats: ['1-1', '1-2'] }),
        fact({ totalRub: 999 }),
        fact({ status: 'PENDING_PAYMENT' }),
        fact({ status: 'CANCELLED', totalRub: 5000 }),
      ],
      { moviesCount: 6, reviewsCount: 3, avgRating: 4.5, upcomingAvgPct: 34 },
    );

    expect(result).toEqual({
      bookingsTotal: 4,
      confirmed: 2,
      revenueRub: 1999, // CANCELLED в выручке не участвует
      avgTicketRub: 1000, // Math.round(999.5)
      seatsSold: 3,
      upcomingOccupancyPct: 34,
      moviesCount: 6,
      reviewsCount: 3,
      avgRating: 4.5,
    });
  });

  it('без продаж — нули вместо NaN', () => {
    const result = totals([fact({ status: 'EXPIRED' })], {
      moviesCount: 0,
      reviewsCount: 0,
      avgRating: 0,
      upcomingAvgPct: 0,
    });

    expect(result.confirmed).toBe(0);
    expect(result.avgTicketRub).toBe(0);
    expect(result.revenueRub).toBe(0);
  });
});

/** компиляционная проверка: тип статуса остался совместим с union */
it('BookingStatus принимает все значения статусной машины', () => {
  const statuses: BookingStatus[] = [
    'PENDING_PAYMENT',
    'PENDING',
    'CONFIRMED',
    'FAILED',
    'EXPIRED',
    'CANCELLING',
    'CANCELLED',
  ];
  expect(countByStatus(statuses.map((status) => fact({ status })))).toBeTruthy();
});

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { Review } from '../reviews/review.entity';
import { RedisService } from '../redis/redis.service';
import { REDIS_CLIENT } from '../redis/redis.tokens';
import { AdminStatsService, ADMIN_STATS_KEY } from './admin-stats.service';

/**
 * Сервис аналитики: агрегаты поверх фейковых репозиториев + живой
 * RedisService на Map-фейке (как movies.service.spec) — проверяем и числа,
 * и механику кэша (db → cache без повторной выгрузки).
 */

describe('AdminStatsService', () => {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;

  let service: AdminStatsService;
  let store: Map<string, string>;
  let bookingsFind: jest.Mock;
  let moviesFind: jest.Mock;

  /** фикстура: 2 фильма, 1 будущий сеанс, 3 брони, 20 занятых мест, 2 отзыва */
  async function setup(rows: {
    bookings?: Partial<Booking>[];
    movies?: Partial<Movie>[];
    occupancy?: Partial<SeatOccupancy>[];
  }) {
    store = new Map();
    bookingsFind = jest.fn(async () =>
      rows.bookings?.map((b) => ({ ...b }) as Booking),
    );
    moviesFind = jest.fn(async () =>
      (rows.movies ?? [{ id: 'm-1', title: 'Фильм А' }]).map(
        (m) => m as Movie,
      ),
    );
    const occupancyFind = jest.fn(async () =>
      (rows.occupancy ?? Array.from({ length: 20 }, (_, i) => ({
        sessionId: 's-1',
        seat: `5-${i + 1}`,
      }))).map((o) => o as SeatOccupancy),
    );
    const sessionsFind = jest.fn(async () =>
      [
        {
          id: 's-1',
          hall: 'IMAX',
          startsAt: new Date(Date.now() + 60 * 60 * 1000),
          movie: { title: 'Фильм А' },
        },
      ] as unknown as Session[],
    );
    const reviewsFind = jest.fn(async () =>
      [{ rating: 5 }, { rating: 4 }].map((r) => r as Review),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminStatsService,
        RedisService,
        {
          provide: REDIS_CLIENT,
          useValue: {
            get: async (key: string) => store.get(key) ?? null,
            set: async (key: string, value: string) => {
              store.set(key, value);
              return 'OK';
            },
            del: async (...keys: string[]) => {
              keys.forEach((k) => store.delete(k));
            },
            ping: async () => 'PONG',
          },
        },
        { provide: getRepositoryToken(Booking), useValue: { find: bookingsFind } },
        {
          provide: getRepositoryToken(SeatOccupancy),
          useValue: { find: occupancyFind },
        },
        { provide: getRepositoryToken(Session), useValue: { find: sessionsFind } },
        { provide: getRepositoryToken(Movie), useValue: { find: moviesFind } },
        { provide: getRepositoryToken(Review), useValue: { find: reviewsFind } },
      ],
    }).compile();

    service = moduleRef.get(AdminStatsService);
    return service;
  }

  it('агрегирует выгрузку: сводка, статусы, топ, сеансы, график', async () => {
    await setup({
      bookings: [
        {
          status: 'CONFIRMED',
          totalRub: 1200,
          seats: ['5-7', '5-8'],
          movieId: 'm-1',
          createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          processedAt: yesterday,
        },
        { status: 'PENDING_PAYMENT', totalRub: 600, seats: ['6-1'], movieId: 'm-1' },
        { status: 'EXPIRED', totalRub: 300, seats: ['7-1'], movieId: 'm-1' },
      ],
      movies: [
        { id: 'm-1', title: 'Фильм А' },
        { id: 'm-2', title: 'Фильм Б' },
      ],
    });

    const { source, data } = await service.getStats();

    expect(source).toBe('db');
    expect(data.totals).toMatchObject({
      bookingsTotal: 3,
      confirmed: 1,
      revenueRub: 1200,
      avgTicketRub: 1200,
      seatsSold: 2,
      moviesCount: 2,
      reviewsCount: 2,
      avgRating: 4.5,
      upcomingOccupancyPct: 25, // 20 из 80 мест
    });
    expect(data.byStatus).toMatchObject({ CONFIRMED: 1, PENDING_PAYMENT: 1, EXPIRED: 1 });
    expect(data.byStatus).toHaveProperty('CANCELLING', 0);

    expect(data.topMovies).toHaveLength(1);
    expect(data.topMovies[0]).toMatchObject({
      movieId: 'm-1',
      title: 'Фильм А',
      bookings: 1,
      seats: 2,
      revenueRub: 1200,
    });

    expect(data.upcomingSessions[0]).toMatchObject({
      sessionId: 's-1',
      movieTitle: 'Фильм А',
      hall: 'IMAX',
      occupied: 20,
      capacity: 80,
      occupancyPct: 25,
    });

    expect(data.revenueByDay).toHaveLength(14);
    const yesterdayBucket = data.revenueByDay.find(
      (d) => d.day === dayKey(yesterday),
    );
    expect(yesterdayBucket).toMatchObject({ bookings: 1, revenueRub: 1200 });
    const totalRevenue = data.revenueByDay.reduce((acc, d) => acc + d.revenueRub, 0);
    expect(totalRevenue).toBe(1200); // PENDING_PAYMENT и EXPIRED не в графике
  });

  it('кэш: второй ответ из Redis, репозитории не выгружаются повторно', async () => {
    await setup({ bookings: [] });

    const first = await service.getStats();
    expect(first.source).toBe('db');
    expect(store.has(ADMIN_STATS_KEY)).toBe(true);
    const findsAfterFirst = bookingsFind.mock.calls.length;

    const second = await service.getStats();
    expect(second.source).toBe('cache');
    expect(second.data.totals).toEqual(first.data.totals);
    expect(bookingsFind.mock.calls.length).toBe(findsAfterFirst);
    expect(moviesFind.mock.calls.length).toBe(1);
  });

  it('пустая база — нулевая сводка без NaN и пустой топ', async () => {
    await setup({ bookings: [], occupancy: [] });

    const { data } = await service.getStats();

    expect(data.totals.avgTicketRub).toBe(0);
    expect(data.totals.upcomingOccupancyPct).toBe(0);
    expect(data.totals.reviewsCount).toBe(2); // фикстура отзывов общая
    expect(data.topMovies).toEqual([]);
    expect(data.revenueByDay).toHaveLength(14);
  });
});

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { MoreThanOrEqual, FindOperator } from 'typeorm';
import { AdminController } from '../src/admin/admin.controller';
import { AdminStatsService, ADMIN_STATS_KEY } from '../src/admin/admin-stats.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { Booking } from '../src/bookings/booking.entity';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { Movie } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { Review } from '../src/reviews/review.entity';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_CLIENT } from '../src/redis/redis.tokens';

/**
 * Интеграционный тест админ-аналитики: реальный HTTP-стек Nest + гварды
 * как в боевом app.module.ts, сервис — настоящий, репозитории и Redis —
 * in-memory фейки (каркас повторяет http.int.spec.ts).
 */

describe('GET /api/admin/stats (integration)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') — см. ConfigService-фейк */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let redisStore: Map<string, string>;
  let bearerAdmin: string;
  let bearerUser: string;

  beforeAll(async () => {
    // фикстура: 2 фильма, 3 будущих сеанса (+1 прошедший), брони во всех
    // состояниях, занятые места, пара отзывов
    const now = Date.now();
    const movieRows = [
      { id: 'm-1', title: 'Фильм А' },
      { id: 'm-2', title: 'Фильм Б' },
    ] as unknown as Movie[];
    const sessionRows = [
      { id: 's-1', movieId: 'm-1', hall: 'IMAX', startsAt: new Date(now + 3600_000), movie: movieRows[0] },
      { id: 's-2', movieId: 'm-2', hall: 'Красный', startsAt: new Date(now + 7200_000), movie: movieRows[1] },
      { id: 's-3', movieId: 'm-1', hall: 'Красный', startsAt: new Date(now + 10800_000), movie: movieRows[0] },
      // прошедший сеанс не должен попасть в «предстоящие»
      { id: 's-past', movieId: 'm-1', hall: 'IMAX', startsAt: new Date(now - 3600_000), movie: movieRows[0] },
    ] as unknown as Session[];

    const booking = (partial: Partial<Booking>): Booking =>
      ({ createdAt: new Date(now), processedAt: null, seats: ['5-7'], ...partial }) as Booking;
    const bookingRows: Booking[] = [
      // выручка фильма А: подтверждённые вчера и сегодня
      booking({ status: 'CONFIRMED', totalRub: 1200, seats: ['5-7', '5-8'], movieId: 'm-1', sessionId: 's-1', processedAt: new Date(now - 24 * 3600_000) }),
      booking({ status: 'CONFIRMED', totalRub: 600, seats: ['6-1'], movieId: 'm-1', sessionId: 's-1', processedAt: new Date(now) }),
      booking({ status: 'CONFIRMED', totalRub: 3000, seats: ['7-1'], movieId: 'm-2', sessionId: 's-2', processedAt: new Date(now) }),
      booking({ status: 'PENDING_PAYMENT', totalRub: 600, seats: ['8-1'], movieId: 'm-2', sessionId: 's-2' }),
      booking({ status: 'EXPIRED', totalRub: 300, seats: ['1-1'], movieId: 'm-2', sessionId: 's-2' }),
    ];

    const occupancyRows = Array.from({ length: 30 }, (_, i) => ({
      sessionId: 's-1',
      seat: `5-${i + 1}`,
    })) as unknown as SeatOccupancy[];
    const reviewRows = [
      { rating: 5 },
      { rating: 4 },
    ] as unknown as Review[];

    redisStore = new Map();

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [AdminController],
      providers: [
        AdminStatsService,
        RedisService,
        {
          provide: REDIS_CLIENT,
          useValue: {
            get: async (key: string) => redisStore.get(key) ?? null,
            set: async (key: string, value: string) => {
              redisStore.set(key, value);
              return 'OK';
            },
            del: async (...keys: string[]) => {
              keys.forEach((k) => redisStore.delete(k));
            },
            ping: async () => 'PONG',
          },
        },
        { provide: getRepositoryToken(Booking), useValue: { find: async () => bookingRows } },
        { provide: getRepositoryToken(SeatOccupancy), useValue: { find: async () => occupancyRows } },
        {
          provide: getRepositoryToken(Session),
          useValue: {
            // как настоящий репозиторий: будущие сеансы по возрастанию времени
            find: async (opts?: {
              where?: { startsAt?: FindOperator<Date> };
              order?: { startsAt?: 'ASC' | 'DESC' };
            }) => {
              const threshold = opts?.where?.startsAt?.value as Date;
              const rows = threshold
                ? sessionRows.filter((s) => s.startsAt >= threshold)
                : [...sessionRows];
              return rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
            },
          },
        },
        { provide: getRepositoryToken(Movie), useValue: { find: async () => movieRows } },
        { provide: getRepositoryToken(Review), useValue: { find: async () => reviewRows } },
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
        JwtStrategy,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    const jwt = moduleRef.get(JwtService);
    const sign = (sub: string, name: string, role: 'user' | 'admin') =>
      jwt.signAsync({ sub, email: `${sub}@test.local`, name, role });
    bearerAdmin = `Bearer ${await sign('admin-1', 'Админ Тестов', 'admin')}`;
    bearerUser = `Bearer ${await sign('user-a', 'Анна Тест', 'user')}`;
  });

  afterAll(async () => {
    await app.close();
  });

  /** локальный день YYYY-MM-DD — как в admin-stats.logic */
  const localDay = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;

  it('401 без токена — deny by default', async () => {
    const res = await request(app.getHttpServer()).get('/api/admin/stats');
    expect(res.status).toBe(401);
  });

  it('403 с токеном обычного пользователя', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/stats')
      .set('Authorization', bearerUser);
    expect(res.status).toBe(403);
  });

  it('200 админу: агрегаты по фикстуре и конверт source=db', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/stats')
      .set('Authorization', bearerAdmin);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('db');

    // сводка: выручка только по CONFIRMED, средний чек 4800/3
    expect(res.body.data.totals).toEqual({
      bookingsTotal: 5,
      confirmed: 3,
      revenueRub: 4800,
      avgTicketRub: 1600,
      seatsSold: 4,
      upcomingOccupancyPct: 13, // только s-1 занят: 30/80 ≈ 38%, среднее по 3 сеансам
      moviesCount: 2,
      reviewsCount: 2,
      avgRating: 4.5,
    });

    // счётчики по статусам — все 7 ключей
    expect(Object.keys(res.body.data.byStatus)).toEqual(
      expect.arrayContaining([
        'PENDING_PAYMENT', 'PENDING', 'CONFIRMED', 'FAILED',
        'EXPIRED', 'CANCELLING', 'CANCELLED',
      ]),
    );
    expect(res.body.data.byStatus.CONFIRMED).toBe(3);
    expect(res.body.data.byStatus.PENDING_PAYMENT).toBe(1);

    // топ: фильм А впереди (2 брони против 1), EXPIRED не в топе
    expect(res.body.data.topMovies).toHaveLength(2);
    expect(res.body.data.topMovies[0]).toMatchObject({
      movieId: 'm-1',
      title: 'Фильм А',
      bookings: 2,
      seats: 3,
      revenueRub: 1800,
    });

    // предстоящие: 3 будущих сеанса по возрастанию, прошедший не попал
    const upcoming = res.body.data.upcomingSessions;
    expect(upcoming.map((s: { sessionId: string }) => s.sessionId)).toEqual([
      's-1', 's-2', 's-3',
    ]);
    expect(upcoming[0]).toMatchObject({
      movieTitle: 'Фильм А',
      hall: 'IMAX',
      occupied: 30,
      capacity: 80,
      occupancyPct: 38,
    });

    // график: 14 дней, сегодняшняя и вчерашняя выручка на месте
    const days = res.body.data.revenueByDay;
    expect(days).toHaveLength(14);
    const today = days[13];
    const yesterday = days[12];
    expect(today).toMatchObject({ day: localDay(new Date()), bookings: 2, revenueRub: 3600 });
    expect(yesterday).toMatchObject({
      day: localDay(new Date(Date.now() - 24 * 3600_000)),
      bookings: 1,
      revenueRub: 1200,
    });
  });

  it('повторный вызов — из Redis-кэша (source=cache)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/stats')
      .set('Authorization', bearerAdmin);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('cache');
    expect(redisStore.has(ADMIN_STATS_KEY)).toBe(true);
  });
});

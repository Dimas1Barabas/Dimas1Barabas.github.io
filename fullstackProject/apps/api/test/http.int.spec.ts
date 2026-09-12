import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import request from 'supertest';
import { DataSource, FindOperator } from 'typeorm';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingStream } from '../src/bookings/booking-stream';
import { BookingsService } from '../src/bookings/bookings.service';
import { SeatsController } from '../src/bookings/seats.controller';
import { HealthController } from '../src/health/health.controller';
import { Movie } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { MoviesController } from '../src/movies/movies.controller';
import { MoviesService } from '../src/movies/movies.service';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_CLIENT } from '../src/redis/redis.tokens';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Booking } from '../src/bookings/booking.entity';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { sseFrames, waitForSseEvent } from './sse';

/**
 * Интеграционный тест: реальный HTTP-стек Nest (роутинг, ValidationPipe,
 * контроллеры → сервисы), но с in-memory фейками Postgres/RabbitMQ/Redis.
 * Кэш — настоящий RedisService поверх Map, т.е. логика кэширования живая.
 * Фейковая «транзакция» выполняет callback с эмуляцией EntityManager;
 * INSERT дубля в seat_occupancy падает кодом 23505 — как pg-констрейнт.
 */

/** «фильм с сеансами», как приходит из сидов/админского create */
type MovieWithSessionSeeds = Partial<Movie> & {
  sessions?: { hall: string; startsAt: Date }[];
};

class FakeMovieRepo {
  rows: Movie[] = [];

  async count(): Promise<number> {
    return this.rows.length;
  }

  async find(_opts?: { relations?: unknown }): Promise<Movie[]> {
    return [...this.rows];
  }

  create(x: MovieWithSessionSeeds): Movie {
    return x as Movie;
  }

  /** save эмулирует cascade: сеансы фильма становятся строками Session */
  async save(
    entities: Movie | Movie[],
  ): Promise<Movie | Movie[]> {
    const list = Array.isArray(entities) ? entities : [entities];
    for (const e of list) {
      // id-uuid, чтобы проходить @IsUUID() в DTO
      if (!e.id) e.id = randomUUID();
      if (!e.createdAt) e.createdAt = new Date();
      // сюда всегда приходят «сырые» сеансы {hall, startsAt} — из сидов
      // и из админского create; раздуваем их в полноценные Session
      e.sessions = (e.sessions ?? []).map((s) => ({
        id: randomUUID(),
        movieId: e.id,
        movie: e,
        hall: s.hall,
        startsAt: s.startsAt,
        createdAt: new Date(),
      }));
      if (!this.rows.includes(e)) this.rows.push(e);
    }
    return entities;
  }

  async findOneByOrFail(where: { id: string }): Promise<Movie> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Фильм не найден');
    return found;
  }
}

class FakeSessionRepo {
  rows: Session[] = [];

  async findOneByOrFail(where: { id: string }): Promise<Session> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Сеанс не найден');
    return found;
  }
}

class FakeBookingRepo {
  rows: Booking[] = [];

  create(x: Partial<Booking>): Booking {
    return x as Booking;
  }

  async save(booking: Booking): Promise<Booking> {
    if (!booking.id) booking.id = randomUUID();
    if (!booking.createdAt) booking.createdAt = new Date();
    booking.updatedAt = new Date();
    if (!this.rows.includes(booking)) {
      this.rows.unshift(booking); // новые сверху — как ORDER BY created_at DESC
    }
    return booking;
  }

  async find(opts?: { where?: { userId?: string } }): Promise<Booking[]> {
    let rows = [...this.rows];
    const userId = opts?.where?.userId;
    if (userId) rows = rows.filter((r) => r.userId === userId);
    return rows;
  }

  async findOneByOrFail(where: { id: string }): Promise<Booking> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Бронь не найдена');
    return found;
  }

  /** условный UPDATE … WHERE id = ? AND status = ? (сага отмены) */
  async update(
    criteria: { id?: string; status?: string },
    patch: Partial<Booking>,
  ): Promise<{ affected: number }> {
    let affected = 0;
    for (const row of this.rows) {
      const byId = !criteria.id || row.id === criteria.id;
      const byStatus = !criteria.status || row.status === criteria.status;
      if (byId && byStatus) {
        Object.assign(row, patch);
        affected++;
      }
    }
    return { affected };
  }

  createQueryBuilder() {
    const self = this;
    const qb: Record<string, unknown> = {};
    const chain = () => qb;
    qb.select = chain;
    qb.addSelect = chain;
    qb.groupBy = chain;
    qb.getRawMany = async () => {
      const counts = new Map<string, number>();
      for (const row of self.rows) {
        counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      }
      return [...counts.entries()].map(([status, count]) => ({
        status,
        count: String(count),
      }));
    };
    return qb;
  }
}

class FakeOccupancyRepo {
  rows: SeatOccupancy[] = [];

  async find(opts?: {
    where?: {
      sessionId?: string;
      bookingId?: string;
      seat?: string | FindOperator<string>;
    };
  }): Promise<SeatOccupancy[]> {
    let rows = [...this.rows];
    const w = opts?.where ?? {};
    if (w.sessionId) rows = rows.filter((r) => r.sessionId === w.sessionId);
    if (w.bookingId) rows = rows.filter((r) => r.bookingId === w.bookingId);
    if (w.seat) {
      if (w.seat instanceof FindOperator) {
        // In(seats) — массив допустимых значений
        const list = w.seat.value as unknown as string[];
        rows = rows.filter((r) => list.includes(r.seat));
      } else {
        rows = rows.filter((r) => r.seat === w.seat);
      }
    }
    return rows;
  }

  async delete(criteria: {
    bookingId?: string;
    sessionId?: string;
    seat?: string;
  }): Promise<{ affected: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) =>
        !(
          (criteria.bookingId && r.bookingId === criteria.bookingId) ||
          (criteria.sessionId &&
            criteria.seat &&
            r.sessionId === criteria.sessionId &&
            r.seat === criteria.seat)
        ),
    );
    return { affected: before - this.rows.length };
  }

  /** INSERT: дубль (sessionId, seat) падает кодом 23505 — как uq-констрейнт */
  insert(
    rows: { sessionId: string; seat: string; bookingId: string }[],
  ): Promise<void> {
    for (const r of rows) {
      if (
        this.rows.some((x) => x.sessionId === r.sessionId && x.seat === r.seat)
      ) {
        return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
      }
    }
    this.rows.push(
      ...rows.map((r) => ({ id: randomUUID(), createdAt: new Date(), ...r })),
    );
    return Promise.resolve();
  }
}

describe('CineBooking API: HTTP-интеграция (фейковые зависимости)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') — см. ConfigService-фейк */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let moviesRepo: FakeMovieRepo;
  let sessionsRepo: FakeSessionRepo;
  let bookingsRepo: FakeBookingRepo;
  let occupancyRepo: FakeOccupancyRepo;
  let redisStore: Map<string, string>;
  let rabbitPublish: jest.Mock;
  let bookingsService: BookingsService;
  /** Authorization: владелец брони, чужак и администратор */
  let bearer: string;
  let bearerB: string;
  let bearerAdmin: string;

  /** каталог из /api/movies (DTO с sessions[]) */
  type MovieDtoJson = {
    id: string;
    title: string;
    priceRub: number;
    sessions: { id: string; hall: string; startsAt: string }[];
  };

  async function catalog(): Promise<MovieDtoJson[]> {
    const res = await request(app.getHttpServer()).get('/api/movies');
    return res.body.data;
  }

  beforeAll(async () => {
    moviesRepo = new FakeMovieRepo();
    sessionsRepo = new FakeSessionRepo();
    bookingsRepo = new FakeBookingRepo();
    occupancyRepo = new FakeOccupancyRepo();
    redisStore = new Map();
    rabbitPublish = jest.fn();

    // эмуляция EntityManager из DataSource.transaction
    const em = {
      findOneByOrFail: (entity: unknown, where: { id: string }) => {
        if (entity === Movie) return moviesRepo.findOneByOrFail(where);
        if (entity === Session) return sessionsRepo.findOneByOrFail(where);
        throw new Error('unexpected entity');
      },
      create: (_entity: unknown, x: Partial<Booking>) => x,
      save: (_entity: unknown, x: Booking) => bookingsRepo.save(x),
      insert: (
        entity: unknown,
        rows: { sessionId: string; seat: string; bookingId: string }[],
      ) => {
        if (entity === SeatOccupancy) return occupancyRepo.insert(rows);
        throw new Error('unexpected entity');
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        // секрет должен совпадать с JwtStrategy (она читает ConfigService-фейк)
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [
        MoviesController,
        BookingsController,
        SeatsController,
        HealthController,
      ],
      providers: [
        MoviesService,
        BookingsService,
        BookingStream,
        RedisService,
        { provide: REDIS_CLIENT, useValue: redisFake(redisStore) },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(Session), useValue: sessionsRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        {
          provide: getRepositoryToken(SeatOccupancy),
          useValue: occupancyRepo,
        },
        { provide: AmqpConnection, useValue: { publish: rabbitPublish, connected: true } },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn(async () => []),
            transaction: (cb: (e: typeof em) => unknown) => cb(em),
          },
        },
        // JwtStrategy берёт секрет из ConfigService; фейк отдаёт дефолт,
        // поэтому AUTH_SECRET объявлен равным 'dev-cine-secret'
        { provide: ConfigService, useValue: { get: (_k: string, def?: string) => def } },
        JwtStrategy,
        // как в AppModule: все эндпоинты за JWT, витрина — @Public(),
        // следом RolesGuard сверяет @Roles(...) с ролью из токена
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init(); // onModuleInit → посев фильмов (с сеансами, каскадом в фейке)

    // строки Session — после каскада в FakeMovieRepo.save
    sessionsRepo.rows = moviesRepo.rows.flatMap((m) => m.sessions ?? []);

    bookingsService = moduleRef.get(BookingsService);

    // три токена: владелец брони, «чужак» и администратор
    const jwt = moduleRef.get(JwtService);
    const sign = (sub: string, name: string, role: 'user' | 'admin') =>
      jwt.signAsync({ sub, email: `${sub}@test.local`, name, role });
    bearer = `Bearer ${await sign('user-a', 'Анна Тест', 'user')}`;
    bearerB = `Bearer ${await sign('user-b', 'Борис Чужой', 'user')}`;
    bearerAdmin = `Bearer ${await sign('admin-1', 'Админ Тестов', 'admin')}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/movies', () => {
    it('первый вызов — из «БД», с посевом 6 фильмов и сеансами', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('db');
      expect(res.body.data).toHaveLength(6);
      expect(res.body.data[0]).toMatchObject({
        title: expect.any(String),
        priceRub: expect.any(Number),
        sessions: expect.any(Array),
      });
      // sessionAt у фильма больше нет — время живёт в сеансах
      expect(res.body.data[0].sessionAt).toBeUndefined();
      expect(res.body.data[0].sessions.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0].sessions[0]).toMatchObject({
        id: expect.any(String),
        hall: expect.any(String),
        startsAt: expect.any(String),
      });
    });

    it('афиша отсортирована по ближайшему сеансу', async () => {
      const data = await catalog();
      // ближайший БУДУЩИЙ сеанс: прошедшие в конце дня уже не считаются
      const now = Date.now();
      const nearest = (m: MovieDtoJson) =>
        Math.min(
          ...m.sessions
            .map((s) => new Date(s.startsAt).getTime())
            .filter((t) => t >= now),
        );
      expect(nearest(data[0])).toBeLessThanOrEqual(nearest(data[1]));
    });

    it('повторный — из Redis-кэша (Map-фейк)', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('cache');
      expect(redisStore.has('movies:all:v2')).toBe(true);
    });
  });

  describe('POST /api/bookings', () => {
    it('создаёт PENDING-бронь по sessionId с данными сеанса и публикует событие', async () => {
      const movies = await catalog();
      const movie = movies[0];
      const session = movie.sessions[0];

      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({
          sessionId: session.id,
          customerName: 'Дмитрий',
          seats: ['5-7', '5-8'],
        });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        seats: ['5-7', '5-8'],
        totalRub: movie.priceRub * 2,
        movieTitle: movie.title,
        sessionId: session.id,
        hall: session.hall,
        sessionAt: session.startsAt,
        customerName: 'Дмитрий',
      });

      expect(rabbitPublish).toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.objectContaining({
          sessionId: session.id,
          hall: session.hall,
          seats: ['5-7', '5-8'],
          totalRub: movie.priceRub * 2,
        }),
      );
    });

    it.each([
      ['мест больше 8', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['1-1','1-2','1-3','1-4','1-5','1-6','1-7','1-8','1-9'] }],
      ['пустой список мест', { sessionId: validUuid(), customerName: 'Дмитрий', seats: [] }],
      ['места не массив', { sessionId: validUuid(), customerName: 'Дмитрий', seats: 2 }],
      ['код не «ряд-место»', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['5'] }],
      ['место вне зала (ряд 9)', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['9-1'] }],
      ['место вне зала (место 11)', { sessionId: validUuid(), customerName: 'Дмитрий', seats: ['1-11'] }],
      ['имя из 1 символа', { sessionId: validUuid(), customerName: 'Д', seats: ['1-1'] }],
      ['не-uuid sessionId', { sessionId: 'abc', customerName: 'Дмитрий', seats: ['1-1'] }],
    ])('400 при невалидных данных: %s', async (_case, payload) => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send(payload);

      expect(res.status).toBe(400);
    });

    it('404 на несуществующий сеанс', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({
          sessionId: '00000000-0000-0000-0000-000000000000',
          customerName: 'Дмитрий',
          seats: ['1-1'],
        });

      expect(res.status).toBe(404);
    });
  });

  describe('изоляция занятости между сеансами', () => {
    it('одно место свободно в другом сеансе того же фильма', async () => {
      const movies = await catalog();
      const movie = movies[0];
      const [first, second] = movie.sessions;
      if (!second) throw new Error('в фикстуре должно быть ≥2 сеанса');

      const taken = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: first.id, customerName: 'Первый сеанс', seats: ['5-5'] });
      expect(taken.status).toBe(201);

      // то же место во втором сеансе — свободно
      const other = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: second.id, customerName: 'Второй сеанс', seats: ['5-5'] });
      expect(other.status).toBe(201);

      // но повторно в первом сеансе — конфликт
      const dup = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: first.id, customerName: 'Дубль', seats: ['5-5'] });
      expect(dup.status).toBe(409);
    });
  });

  describe('авторизация: Bearer-JWT на мутациях', () => {
    it('401: POST /api/bookings без токена', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .send({ sessionId: validUuid(), seats: ['1-1'] });

      expect(res.status).toBe(401);
    });

    it('401: мусорный токен', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', 'Bearer not-a-jwt')
        .send({ sessionId: validUuid(), seats: ['1-1'] });

      expect(res.status).toBe(401);
    });

    it('имя покупателя из JWT, когда customerName не передан', async () => {
      const movies = await catalog();
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: movies[5].sessions[0].id, seats: ['2-5'] });

      expect(res.status).toBe(201);
      expect(res.body.customerName).toBe('Анна Тест');
      expect(res.body.userId).toBe('user-a');
    });

    it('403: чужую бронь отменить нельзя', async () => {
      const movies = await catalog();
      const created = (
        await request(app.getHttpServer())
          .post('/api/bookings')
          .set('Authorization', bearer)
          .send({
            sessionId: movies[5].sessions[0].id,
            customerName: 'Владелец',
            seats: ['2-6'],
          })
      ).body;
      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`)
        .set('Authorization', bearerB);

      expect(res.status).toBe(403);
    });

    it('витрина без токена открыта: movies, seats, stats, health', async () => {
      const movies = await catalog();
      expect(
        (await request(app.getHttpServer()).get('/api/movies')).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer()).get(
            `/api/sessions/${movies[0].sessions[0].id}/seats`,
          )
        ).status,
      ).toBe(200);
      expect(
        (await request(app.getHttpServer()).get('/api/bookings/stats')).status,
      ).toBe(200);
      expect(
        (await request(app.getHttpServer()).get('/api/health')).status,
      ).toBe(200);
    });
  });

  describe('личный кабинет: GET /api/bookings/my', () => {
    it('401 без токена', async () => {
      const res = await request(app.getHttpServer()).get('/api/bookings/my');

      expect(res.status).toBe(401);
    });

    it('показывает только брони владельца из токена', async () => {
      const movies = await catalog();
      const foreign = (
        await request(app.getHttpServer())
          .post('/api/bookings')
          .set('Authorization', bearerB)
          .send({ sessionId: movies[5].sessions[0].id, seats: ['3-1'] })
      ).body;
      expect(foreign.userId).toBe('user-b');

      const mine = await request(app.getHttpServer())
        .get('/api/bookings/my')
        .set('Authorization', bearer);
      const theirs = await request(app.getHttpServer())
        .get('/api/bookings/my')
        .set('Authorization', bearerB);

      expect(mine.status).toBe(200);
      expect(mine.body).toHaveLength(
        bookingsRepo.rows.filter((r) => r.userId === 'user-a').length,
      );
      expect(mine.body.every((b: { userId: string }) => b.userId === 'user-a')).toBe(true);
      expect(theirs.body).toHaveLength(1);
      expect(theirs.body[0]).toMatchObject({ id: foreign.id, userId: 'user-b' });
    });

    it('пусто у пользователя без броней', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/bookings/my')
        .set('Authorization', bearerAdmin);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('админ: POST /api/movies (@Roles admin)', () => {
    const newMovie = {
      title: 'Тестовый сеанс',
      description: 'Фильм, созданный интеграционным тестом',
      genre: 'тест',
      genreIcon: '🧪',
      durationMin: 90,
      priceRub: 350,
      hue: 120,
      sessions: [
        { hall: 'IMAX', startsAt: '2026-12-31T23:00:00Z' },
        { hall: 'Красный', startsAt: '2027-01-01T13:00:00Z' },
      ],
    };

    it('401 без токена', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .send(newMovie);
      expect(res.status).toBe(401);
    });

    it('403 с токеном обычного пользователя', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearer)
        .send(newMovie);
      expect(res.status).toBe(403);
    });

    it('201 с админским токеном; сеансы создались, каталог обновился, кэш сброшен', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send(newMovie);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ title: 'Тестовый сеанс', priceRub: 350 });
      expect(res.body.id).toBeTruthy();
      expect(res.body.sessions).toHaveLength(2);
      expect(res.body.sessions[0]).toMatchObject({ hall: 'IMAX' });

      // до создания кэш прогрет одним из предыдущих GET /api/movies;
      // create его сбросил — список читается из «БД» и содержит новинку
      const list = await request(app.getHttpServer()).get('/api/movies');
      expect(list.body.source).toBe('db');
      expect(
        list.body.data.some((m: { title: string }) => m.title === 'Тестовый сеанс'),
      ).toBe(true);
    });

    it('400 с кривыми данными (hue вне 0–360)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send({ ...newMovie, title: 'Кривой hue', hue: 999 });

      expect(res.status).toBe(400);
    });

    it('400 без единого сеанса', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send({ ...newMovie, title: 'Без сеансов', sessions: [] });

      expect(res.status).toBe(400);
    });

    it('400 с мусором вместо объекта сеанса (nested-валидация)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/movies')
        .set('Authorization', bearerAdmin)
        .send({
          ...newMovie,
          title: 'Мусорный сеанс',
          sessions: [{ hall: 'IMAX', startsAt: 'завтра-в-семь' }],
        });

      expect(res.status).toBe(400);
    });
  });

  describe('гонка за места: констрейнт (session_id, seat)', () => {
    it('409 со списком мест при повторном бронировании занятого', async () => {
      const movies = await catalog();
      const session = movies[0].sessions[0];

      const first = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Первый', seats: ['4-4'] });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({
          sessionId: session.id,
          customerName: 'Второй',
          seats: ['4-3', '4-4'],
        });

      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        statusCode: 409,
        seatsTaken: ['4-4'],
      });
      expect(second.body.message).toContain('4-4');
      // свободное место из отклонённой брони не занялось
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toContain('4-4');
      expect(map.body.occupied).not.toContain('4-3');
    });

    it('GET /api/sessions/:id/seats — геометрия зала и счётчик свободных', async () => {
      const movies = await catalog();
      const session = movies[1].sessions[0];
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);

      expect(map.status).toBe(200);
      expect(map.body.layout).toEqual({ rows: 8, seatsPerRow: 10 });
      expect(map.body.sessionId).toBe(session.id);
      expect(map.body.free + map.body.occupied.length).toBe(80);
    });

    it('GET /api/sessions/:id/seats — 404 на несуществующий сеанс', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/sessions/00000000-0000-0000-0000-000000000000/seats');
      expect(res.status).toBe(404);
    });
  });

  describe('полный цикл брони: вердикт Go-воркера', () => {
    it('handleProcessed → бронь становится CONFIRMED и видна в списке и статистике', async () => {
      const movies = await catalog();
      const session = movies[0].sessions[0];
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: session.id,
          customerName: 'Аноним',
          seats: ['6-1', '6-2', '6-3'],
        })
      ).body;

      // то, что в реальном стеке делает Go ticket-worker через RabbitMQ
      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'CONFIRMED',
        message: 'Оплата прошла. Места 6-1, 6-2, 6-3.',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (
        await request(app.getHttpServer()).get('/api/bookings')
      ).body;
      const updated = list.find((b: { id: string }) => b.id === created.id);

      expect(updated.status).toBe('CONFIRMED');
      expect(updated.message).toContain('6-1');
      expect(updated.processedBy).toBe('go-worker-1');
      expect(updated.processedAt).toBeTruthy();

      // подтверждённая бронь держит места своего сеанса
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toEqual(
        expect.arrayContaining(['6-1', '6-2', '6-3', '5-7', '5-8', '4-4']),
      );

      const stats = (
        await request(app.getHttpServer()).get('/api/bookings/stats')
      ).body;
      expect(stats.CONFIRMED).toBeGreaterThanOrEqual(1);
    });

    it('FAILED → места освобождаются, и их снова можно забронировать', async () => {
      const movies = await catalog();
      const session = movies[2].sessions[0];

      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: session.id,
          customerName: 'Отказ',
          seats: ['2-2'],
        })
      ).body;

      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'FAILED',
        message: 'Платёж отклонён банком (код 42). Бронь отменена.',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('2-2');

      const rebook = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Повтор', seats: ['2-2'] });
      expect(rebook.status).toBe(201);
    });
  });

  describe('сага отмены: возврат через Go-воркера', () => {
    /** создаёт и «оплачивает» бронь — готова к отмене */
    async function confirmedBooking(
      sessionId: string,
      seats: string[],
      name: string,
    ) {
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId,
          customerName: name,
          seats,
        })
      ).body;
      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });
      return created;
    }

    it('cancel: CONFIRMED → CANCELLING, публикация booking.cancelled с сеансом', async () => {
      const movies = await catalog();
      const session = movies[3].sessions[0];
      const created = await confirmedBooking(session.id, ['3-5', '3-6'], 'Отмена');

      rabbitPublish.mockClear();
      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('CANCELLING');
      expect(rabbitPublish).toHaveBeenCalledWith(
        'cinema',
        'booking.cancelled',
        expect.objectContaining({
          bookingId: created.id,
          sessionId: session.id,
          seats: ['3-5', '3-6'],
          totalRub: created.totalRub,
        }),
      );

      // до вердикта возврата места держатся занятыми
      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toEqual(expect.arrayContaining(['3-5', '3-6']));

      // повторная отмена по CANCELLING — 409: гонку закрыл статус
      const again = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);
      expect(again.status).toBe(409);
    });

    it('booking.refunded CANCELLED → места свободны и снова покупаемы', async () => {
      const movies = await catalog();
      const session = movies[4].sessions[0];
      const created = await confirmedBooking(session.id, ['7-1'], 'Возврат');
      await request(app.getHttpServer()).post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      // то, что в реальном стеке делает Go ticket-worker через RabbitMQ
      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'CANCELLED',
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const cancelled = list.find((b: { id: string }) => b.id === created.id);
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.message).toContain('Возврат');

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('7-1');

      const rebook = await request(app.getHttpServer())
        .post('/api/bookings')
        .set('Authorization', bearer)
        .send({ sessionId: session.id, customerName: 'Снова', seats: ['7-1'] });
      expect(rebook.status).toBe(201);
    });

    it('booking.refunded REFUND_FAILED → откат в CONFIRMED, места держатся', async () => {
      const movies = await catalog();
      const session = movies[5].sessions[0];
      const created = await confirmedBooking(session.id, ['8-10'], 'Банк не смог');
      await request(app.getHttpServer()).post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'REFUND_FAILED',
        message: 'Банк отклонил возврат (код 77).',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const restored = list.find((b: { id: string }) => b.id === created.id);
      expect(restored.status).toBe('CONFIRMED');
      expect(restored.message).toContain('возврат');

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).toContain('8-10');
    });

    it('409 на отмену брони не в CONFIRMED (PENDING)', async () => {
      const movies = await catalog();
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').set('Authorization', bearer).send({
          sessionId: movies[0].sessions[0].id,
          customerName: 'Нетерпеливый',
          seats: ['1-8'],
        })
      ).body;

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ status: 'PENDING' });
    });

    it('404 на отмену несуществующей брони', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings/00000000-0000-0000-0000-000000000000/cancel')
        .set('Authorization', bearer);
      expect(res.status).toBe(404);
    });

    it('ределивери booking.refunded по закрытой саге — без последствий', async () => {
      const movies = await catalog();
      const session = movies[4].sessions[0];
      const created = await confirmedBooking(session.id, ['2-9'], 'Дубль');
      await request(app.getHttpServer()).post(`/api/bookings/${created.id}/cancel`).set('Authorization', bearer);
      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'CANCELLED',
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      // тот же вердикт приходит повторно (например, из-за ретрая)
      await bookingsService.handleRefunded({
        bookingId: created.id,
        status: 'CANCELLED',
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (await request(app.getHttpServer()).get('/api/bookings')).body;
      const cancelled = list.find((b: { id: string }) => b.id === created.id);
      expect(cancelled.status).toBe('CANCELLED');

      const map = await request(app.getHttpServer())
        .get(`/api/sessions/${session.id}/seats`);
      expect(map.body.occupied).not.toContain('2-9');
    });
  });

  describe('SSE: GET /api/bookings/stream', () => {
    /**
     * SSE — вечный ответ, supertest его не прочитает: поднимаем реальный
     * http-сервер на случайном порту и читаем фреймы из fetch-стрима.
     */
    it('событие booking прилетает при создании брони', async () => {
      await app.listen(0);
      const address = app.getHttpServer().address() as AddressInfo;
      const base = `http://127.0.0.1:${address.port}`;

      const controller = new AbortController();
      const res = await fetch(`${base}/api/bookings/stream`, {
        signal: controller.signal,
      });
      expect(res.ok).toBe(true);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const frames = sseFrames(res.body!);
      const movies = (
        (await (await fetch(`${base}/api/movies`)).json()) as {
          data: { sessions: { id: string }[] }[];
        }
      ).data;
      const created = (
        await (
          await fetch(`${base}/api/bookings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: bearer },
            body: JSON.stringify({
              sessionId: movies[1].sessions[0].id,
              customerName: 'SSE-клиент',
              seats: ['1-2'],
            }),
          })
        ).json()
      ) as { id: string; status: string };

      const payload = await waitForSseEvent<{
        booking: { id: string; status: string };
        stats: Record<string, number>;
      }>(frames, 'booking', (p) => p.booking.id === created.id);

      expect(payload.booking.status).toBe('PENDING');
      expect(payload.booking.id).toBe(created.id);
      expect(payload.stats).toHaveProperty('PENDING');

      controller.abort();
    });
  });

  describe('GET /api/health', () => {
    it('все фейки живы → ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks).toEqual({
        postgres: 'up',
        redis: 'up',
        rabbitmq: 'up',
      });
    });
  });
});

function redisFake(store: Map<string, string>) {
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      keys.forEach((k) => store.delete(k));
    },
    ping: async () => 'PONG',
  };
}

/** валидный по формату uuid, которого нет в фейк-репозитории */
function validUuid(): string {
  return '00000000-0000-4000-8000-000000000001';
}

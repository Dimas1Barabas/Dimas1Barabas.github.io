/**
 * Общая основа HTTP-интеграционных тестов: реальный HTTP-стек Nest (роутинг,
 * ValidationPipe, контроллеры → сервисы), но с in-memory фейками
 * Postgres/RabbitMQ/Redis. Кэш — настоящий RedisService поверх Map, т.е.
 * логика кэширования живая. Фейковая «транзакция» выполняет callback с
 * эмуляцией EntityManager; INSERT дубля в seat_occupancy падает кодом 23505 —
 * как pg-констрейнт.
 *
 * Раньше всё это было шапкой одного большого http.int.spec.ts — по образцу
 * bookings.service.harness.ts вынесено для доменных спек: movies.int /
 * bookings.int / bookings-cancel.int. Каждый спек поднимает своё приложение
 * (свой посев каталога и свои токены) — состояние между файлами не течёт.
 */
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
import { SeatStream } from '../src/bookings/seat-stream';
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
import { Promo } from '../src/promos/promo.entity';
import { PricingClient } from '../src/pricing/pricing.client';
import { RateLimiterClient } from '../src/ratelimiter/ratelimiter.client';
import { RemindersClient } from '../src/reminders/reminders.client';
import { User } from '../src/users/user.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';
import { randomUUID } from 'node:crypto';

/** gRPC-клиент напоминаний: вердиктные хуки зовут его fire-and-forget */
export function remindersFake() {
  return {
    schedule: jest.fn(async () => ({ status: 'SCHEDULED', dueAt: '2026-09-25T17:00:00Z' })),
    cancel: jest.fn(async () => ({ status: 'CANCELLED' })),
  };
}

/** gRPC-клиент Тарификатора: базовая цена без факторов (ценовые кейсы — в pricing.int) */
export function pricingFake() {
  return {
    quote: jest.fn(async (input: { basePriceRub: number }) => ({ priceRub: input.basePriceRub, basePriceRub: input.basePriceRub, factors: [], occupied: 0, capacity: 80 })),
  };
}

/** Map-фейк Redis-клиента: get/set/del/ping поверх переданного store */
export function redisFake(store: Map<string, string>) {
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
export function validUuid(): string {
  return '00000000-0000-4000-8000-000000000001';
}

/** каталог из /api/movies (DTO с sessions[]) */
export type MovieDtoJson = {
  id: string;
  title: string;
  priceRub: number;
  sessions: { id: string; hall: string; startsAt: string }[];
};

export async function requestCatalog(app: INestApplication): Promise<MovieDtoJson[]> {
  const res = await request(app.getHttpServer()).get('/api/movies');
  return res.body.data;
}

/** «фильм с сеансами», как приходит из сидов/админского create */
type MovieWithSessionSeeds = Partial<Movie> & {
  sessions?: { hall: string; startsAt: Date }[];
};

export class FakeMovieRepo {
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

export class FakeSessionRepo {
  rows: Session[] = [];

  async findOneByOrFail(where: { id: string }): Promise<Session> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Сеанс не найден');
    return found;
  }
}

export class FakeBookingRepo {
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

export class FakeOccupancyRepo {
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

/** контекст доменного int-спека: приложение и всё, что нужно тестам */
export interface IntAppContext {
  app: INestApplication;
  moviesRepo: FakeMovieRepo;
  sessionsRepo: FakeSessionRepo;
  bookingsRepo: FakeBookingRepo;
  occupancyRepo: FakeOccupancyRepo;
  promosRepo: { findOneBy: jest.Mock };
  redisStore: Map<string, string>;
  rabbitPublish: jest.Mock;
  bookingsService: BookingsService;
  /** Authorization: владелец брони, чужак и администратор */
  bearer: string;
  bearerB: string;
  bearerAdmin: string;
}

/**
 * Поднимает приложение целиком (как делал beforeAll одного большого
 * http.int.spec.ts): фейковые репозитории, эм-транзакция с bonus-ledger,
 * JWT-модуль с тремя токенами, глобальные гварды. Посев каталога —
 * в onModuleInit MoviesService.
 */
export async function buildHttpIntApp(): Promise<IntAppContext> {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') — см. ConfigService-фейк */
  const AUTH_SECRET = 'dev-cine-secret';

  const moviesRepo = new FakeMovieRepo();
  const sessionsRepo = new FakeSessionRepo();
  const bookingsRepo = new FakeBookingRepo();
  const occupancyRepo = new FakeOccupancyRepo();
  // промокоды: enough для pay — причина отказа после отката транзакции
  const promosRepo = { findOneBy: jest.fn(async () => null) };
  const redisStore = new Map<string, string>();
  const rabbitPublish = jest.fn();

  // эмуляция EntityManager из DataSource.transaction
  // bonusRows — фейковый ledger: кэшбэк вердиктов и развороты при отмене
  const bonusRows: {
    userId: string;
    bookingId: string;
    kind: string;
    reason: string;
    amount: number;
  }[] = [];
  const em = {
    findOneByOrFail: (entity: unknown, where: { id: string }) => {
      if (entity === Movie) return moviesRepo.findOneByOrFail(where);
      if (entity === Session) return sessionsRepo.findOneByOrFail(where);
      // вердикты воркера перечитывают бронь внутри транзакции
      if (entity === Booking) return bookingsRepo.findOneByOrFail(where);
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
    // pay(): условный UPDATE статуса и запись скидки — как реальный em
    update: (
      entity: unknown,
      criteria: { id?: string; status?: string },
      patch: Partial<Booking>,
    ) => {
      if (entity === Booking) return bookingsRepo.update(criteria, patch);
      throw new Error('unexpected entity');
    },
    // handleExpired(): гашение EXPIRED возвращает места — в той же транзакции
    delete: (entity: unknown, criteria: { bookingId: string }) => {
      if (entity === SeatOccupancy) return occupancyRepo.delete(criteria);
      throw new Error('unexpected entity');
    },
    // сырой UPDATE promos в оплате с промокодом; баланс/строки —
    // от фейкового ledger'а (SUM в pg — bigint, строкой)
    query: jest.fn(async (sql: string, params: string[]) => {
      if (sql.includes('FROM bonus_transactions WHERE user_id')) {
        const balance = bonusRows
          .filter((r) => r.userId === params[0])
          .reduce(
            (s, r) => s + (r.kind === 'accrual' ? r.amount : -r.amount),
            0,
          );
        return [{ balance: String(balance) }];
      }
      if (sql.includes('SELECT reason, amount FROM bonus_transactions')) {
        return bonusRows
          .filter((r) => r.bookingId === params[0])
          .map((r) => ({ reason: r.reason, amount: r.amount }));
      }
      return [[], 0];
    }),
    // INSERT INTO bonus_transactions … ON CONFLICT (booking_id, reason)
    createQueryBuilder: () => ({
      insert: () => ({
        into: () => ({
          values: (
            v: {
              userId: string;
              bookingId: string;
              kind: string;
              reason: string;
              amount: number;
            },
          ) => ({
            orIgnore: () => ({
              execute: async () => {
                const dup = bonusRows.some(
                  (r) =>
                    r.bookingId === v.bookingId && r.reason === v.reason,
                );
                if (dup) return;
                bonusRows.push(v);
              },
            }),
          }),
        }),
      }),
    }),
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
      SeatStream,
      RedisService,
      { provide: REDIS_CLIENT, useValue: redisFake(redisStore) },
      { provide: getRepositoryToken(Movie), useValue: moviesRepo },
      { provide: getRepositoryToken(Session), useValue: sessionsRepo },
      { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
      {
        provide: getRepositoryToken(SeatOccupancy),
        useValue: occupancyRepo,
      },
      { provide: getRepositoryToken(Promo), useValue: promosRepo },
      // create() гасит запись листа ожидания — фейку достаточно update
      { provide: getRepositoryToken(WaitlistEntry), useValue: { update: jest.fn(async () => ({ affected: 0 })) } },
      // email адресата «письма»-напоминания + gRPC-клиент reminder'ов
      { provide: getRepositoryToken(User), useValue: { findOneByOrFail: jest.fn() } },
      { provide: RemindersClient, useValue: remindersFake() },
      { provide: PricingClient, useValue: pricingFake() },
      { provide: RateLimiterClient, useValue: { check: jest.fn(async () => ({ allowed: true })) } },
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

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  await app.init(); // onModuleInit → посев фильмов (с сеансами, каскадом в фейке)

  // строки Session — после каскада в FakeMovieRepo.save
  sessionsRepo.rows = moviesRepo.rows.flatMap((m) => m.sessions ?? []);

  // три токена: владелец брони, «чужак» и администратор
  const jwt = moduleRef.get(JwtService);
  const sign = (sub: string, name: string, role: 'user' | 'admin') =>
    jwt.signAsync({ sub, email: `${sub}@test.local`, name, role });

  return {
    app,
    moviesRepo,
    sessionsRepo,
    bookingsRepo,
    occupancyRepo,
    promosRepo,
    redisStore,
    rabbitPublish,
    bookingsService: moduleRef.get(BookingsService),
    bearer: `Bearer ${await sign('user-a', 'Анна Тест', 'user')}`,
    bearerB: `Bearer ${await sign('user-b', 'Борис Чужой', 'user')}`,
    bearerAdmin: `Bearer ${await sign('admin-1', 'Админ Тестов', 'admin')}`,
  };
}

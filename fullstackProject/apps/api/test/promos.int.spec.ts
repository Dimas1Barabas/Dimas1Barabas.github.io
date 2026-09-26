import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { APP_GUARD } from '@nestjs/core';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { Booking } from '../src/bookings/booking.entity';
import { BookingStream } from '../src/bookings/booking-stream';
import { SeatStream } from '../src/bookings/seat-stream';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingsService } from '../src/bookings/bookings.service';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { Movie } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { Promo } from '../src/promos/promo.entity';
import { PricingClient } from '../src/pricing/pricing.client';
import { RateLimiterClient } from '../src/ratelimiter/ratelimiter.client';
import { RemindersClient } from '../src/reminders/reminders.client';
import { User } from '../src/users/user.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';
import { PromosController } from '../src/promos/promos.controller';
import { PromosService } from '../src/promos/promos.service';

/**
 * Интеграционный тест промокодов: реальный HTTP-стек Nest (роутинг,
 * ValidationPipe, контроллеры → сервисы, JWT/roles-гварды), но с
 * in-memory фейками Postgres. consume() фейка честно исполняет
 * атомарный условный UPDATE активации — как настоящий PG в гонке
 * за последний код; update() брони — условный UPDATE по статусу.
 */

/** unique_violation в Postgres */
class FakePromoRepo {
  rows: Promo[] = [];

  create(x: Partial<Promo>): Promo {
    return x as Promo;
  }

  async save(x: Promo): Promise<Promo> {
    if (this.rows.some((r) => r.code === x.code)) {
      throw { code: '23505' }; // uq_promos_code
    }
    // merge с датами эмулирует БД
    const row = {
      ...x,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async find(): Promise<Promo[]> {
    return [...this.rows].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async findOneBy(where: { code: string }): Promise<Promo | null> {
    return this.rows.find((r) => r.code === where.code) ?? null;
  }

  /**
   * UPDATE promos SET used_count = used_count + 1
   *   WHERE code = $1 AND used_count < max_activations
   *     AND expires_at > now()
   *   RETURNING code, kind, value
   * — форма ответа как у postgres-драйвера TypeORM: [строки, count]
   */
  async consume(
    code: string,
  ): Promise<[{ code: string; kind: Promo['kind']; value: number }[], number]> {
    const promo = this.rows.find((r) => r.code === code);
    if (
      !promo ||
      promo.usedCount >= promo.maxActivations ||
      promo.expiresAt.getTime() <= Date.now()
    ) {
      return [[], 0];
    }
    promo.usedCount += 1;
    return [[{ code: promo.code, kind: promo.kind, value: promo.value }], 1];
  }
}

class FakeBookingRepo {
  rows: Booking[] = [];

  async findOneByOrFail(where: { id: string }): Promise<Booking> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Бронь не найдена');
    return found;
  }

  /**
   * Условный UPDATE: criteria.status — как WHERE в реальном PG. Строка
   * заменяется копией, а не мутируется: SQL UPDATE не трогает объект в
   * памяти сервиса (иначе скидка применялась бы дважды — detach, как в TypeORM).
   */
  async update(
    criteria: { id?: string; status?: string },
    patch: Partial<Booking>,
  ): Promise<{ affected: number }> {
    const idx = this.rows.findIndex(
      (r) =>
        r.id === criteria.id && (!criteria.status || r.status === criteria.status),
    );
    if (idx === -1) return { affected: 0 };
    this.rows[idx] = { ...this.rows[idx], ...patch };
    return { affected: 1 };
  }

  /** GROUP BY по статусам — для stats() в SSE-push */
  createQueryBuilder() {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => this.rows.map((r) => ({ status: r.status, count: 1 }))),
    };
  }
}

describe('Промокоды: HTTP-интеграция (фейковые зависимости)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let promosRepo: FakePromoRepo;
  let bookingsRepo: FakeBookingRepo;
  /** опубликованные в RabbitMQ события */
  let published: { routingKey: string; payload: Record<string, unknown> }[];

  /** Authorization: владелец брони, «чужак» и администратор */
  let bearer: string;
  let bearerB: string;
  let bearerAdmin: string;

  /** сеанс и фильм фикстуры — контекст брони для события воркеру */
  const sessionId = randomUUID();
  const movieId = randomUUID();

  const promoRow = (overrides: Partial<Promo> = {}): Promo => ({
    id: randomUUID(),
    code: 'E2E10',
    kind: 'percent',
    value: 10,
    maxActivations: 100,
    usedCount: 0,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  /** бронь «владельца» (user-a), ждущая оплаты, на 1000 ₽ */
  const seedBooking = (overrides: Partial<Booking> = {}): Booking => {
    const row: Booking = {
      id: randomUUID(),
      movieId,
      movie: {} as Booking['movie'],
      sessionId,
      session: {} as Booking['session'],
      customerName: 'Анна Тест',
      userId: 'user-a',
      seats: ['5-7'],
      totalRub: 1000,
      promoCode: null,
      discountRub: null,
      bonusSpent: null,
      status: 'PENDING_PAYMENT',
      expiresAt: new Date(Date.now() + 60_000),
      message: null,
      processedBy: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    bookingsRepo.rows.push(row);
    return row;
  };

  beforeAll(async () => {
    promosRepo = new FakePromoRepo();
    bookingsRepo = new FakeBookingRepo();
    published = [];

    const moviesRepo = {
      findOneByOrFail: jest.fn(async (_where: { id: string }) => ({
        id: movieId,
        title: 'Рекурсия',
        hue: 275,
        genreIcon: '🌀',
      })),
    };
    const sessionsRepo = {
      findOneByOrFail: jest.fn(async (_where: { id: string }) => ({
        id: sessionId,
        movieId,
        hall: 'IMAX',
        startsAt: new Date('2026-09-25T19:00:00Z'),
      })),
    };
    const occupancyRepo = { insert: jest.fn(), delete: jest.fn(), find: jest.fn(async () => []) };

    // эмуляция EntityManager из DataSource.transaction
    const em = {
      findOneByOrFail: (entity: unknown, where: { id: string }) => {
        if (entity === Session) return sessionsRepo.findOneByOrFail(where);
        if (entity === Movie) return moviesRepo.findOneByOrFail(where);
        if (entity === Booking) return bookingsRepo.findOneByOrFail(where);
        throw new Error('unexpected entity');
      },
      create: (_entity: unknown, x: Partial<Booking>) => x,
      save: (_entity: unknown, x: Booking) => x,
      insert: jest.fn(),
      update: (
        entity: unknown,
        criteria: { id?: string; status?: string },
        patch: Partial<Booking>,
      ) => {
        if (entity === Booking) return bookingsRepo.update(criteria, patch);
        throw new Error('unexpected entity');
      },
      // сырой UPDATE активации — форма [строки, count] как у драйвера
      query: (sql: string, params: string[]) =>
        sql.startsWith('UPDATE promos')
          ? promosRepo.consume(params[0])
          : Promise.resolve([[], 0]),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [PromosController, BookingsController],
      providers: [
        PromosService,
        BookingsService,
        BookingStream,
        SeatStream,
        { provide: getRepositoryToken(Promo), useValue: promosRepo },
        // create() гасит запись листа ожидания — фейку достаточно update
        { provide: getRepositoryToken(WaitlistEntry), useValue: { update: jest.fn(async () => ({ affected: 0 })) } },
        // email напоминаний + gRPC-клиент reminder'ов (вердиктные хуки)
        { provide: getRepositoryToken(User), useValue: { findOneByOrFail: jest.fn() } },
        { provide: RemindersClient, useValue: { schedule: jest.fn(async () => ({ status: 'SCHEDULED' })), cancel: jest.fn(async () => ({ status: 'CANCELLED' })) } },
        // Тарификатор: базовая цена без факторов (ценовые кейсы — в pricing.int)
        { provide: PricingClient, useValue: { quote: jest.fn(async (input: { basePriceRub: number }) => ({ priceRub: input.basePriceRub, basePriceRub: input.basePriceRub, factors: [], occupied: 0, capacity: 80 })) } },
        { provide: RateLimiterClient, useValue: { check: jest.fn(async () => ({ allowed: true })) } },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(Session), useValue: sessionsRepo },
        { provide: getRepositoryToken(SeatOccupancy), useValue: occupancyRepo },
        {
          provide: AmqpConnection,
          useValue: {
            connected: true,
            publish: (_ex: string, routingKey: string, payload: unknown) =>
              published.push({ routingKey, payload: payload as Record<string, unknown> }),
          },
        },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn(async () => [[], 0]),
            /**
             * «Транзакция» с честным ROLLBACK: строки мутируются напрямую
             * (фейковые update/consume), поэтому на входе снимаем состояние,
             * и если callback бросил — возвращаем как было. Иначе тесты
             * гонки за промокод не доказали бы «бронь осталась payable».
             */
            transaction: async (cb: (e: typeof em) => unknown) => {
              const bookingsSnap = bookingsRepo.rows.map((r) => ({ ...r }));
              const promosSnap = promosRepo.rows.map((r) => ({ ...r }));
              try {
                return await cb(em);
              } catch (err) {
                bookingsRepo.rows.splice(
                  0,
                  bookingsRepo.rows.length,
                  ...bookingsSnap.map((r) => ({ ...r })),
                );
                promosRepo.rows.splice(
                  0,
                  promosRepo.rows.length,
                  ...promosSnap.map((r) => ({ ...r })),
                );
                throw err;
              }
            },
          },
        },
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
    bearer = `Bearer ${await sign('user-a', 'Анна Тест', 'user')}`;
    bearerB = `Bearer ${await sign('user-b', 'Борис Чужой', 'user')}`;
    bearerAdmin = `Bearer ${await sign('admin-1', 'Админ Тестов', 'admin')}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('админ: POST /api/promos и GET /api/promos', () => {
    const createDto = (overrides: Record<string, unknown> = {}) => ({
      code: 'e2e-cine',
      kind: 'percent',
      value: 10,
      maxActivations: 100,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...overrides,
    });

    it('401 без токена и 403 обычному пользователю', async () => {
      const noAuth = await request(app.getHttpServer())
        .post('/api/promos')
        .send(createDto());
      const asUser = await request(app.getHttpServer())
        .post('/api/promos')
        .set('Authorization', bearer)
        .send(createDto());

      expect(noAuth.status).toBe(401);
      expect(asUser.status).toBe(403);
    });

    it('201 админу: код нормализован в верхний регистр, в списке usedCount 0', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/promos')
        .set('Authorization', bearerAdmin)
        .send(createDto({ code: 'e2e-cine' }));

      expect(res.status).toBe(201);
      expect(res.body.code).toBe('E2E-CINE');

      const list = await request(app.getHttpServer())
        .get('/api/promos')
        .set('Authorization', bearerAdmin);
      expect(list.status).toBe(200);
      expect(list.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'E2E-CINE', usedCount: 0 }),
        ]),
      );
    });

    it('409 promoExists на дубль кода (регистронезависимо)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/promos')
        .set('Authorization', bearerAdmin)
        .send(createDto({ code: 'E2E-CINE' }));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('promoExists');
    });

    it('400 на кривые данные (percent 150)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/promos')
        .set('Authorization', bearerAdmin)
        .send(createDto({ value: 150 }));

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/promos/validate', () => {
    it('200: превью процента — скидка и итог по сумме брони', async () => {
      const booking = seedBooking();
      promosRepo.rows.push(promoRow({ code: 'VALID10' }));

      const res = await request(app.getHttpServer())
        .post('/api/promos/validate')
        .set('Authorization', bearer)
        .send({ code: 'valid10', bookingId: booking.id });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        code: 'VALID10',
        kind: 'percent',
        value: 10,
        discountRub: 100,
        totalRub: 900,
      });
    });

    it('200: фикс больше суммы клампится — итог 0', async () => {
      const booking = seedBooking();
      promosRepo.rows.push(promoRow({ code: 'BIGFIX', kind: 'fixed', value: 5000 }));

      const res = await request(app.getHttpServer())
        .post('/api/promos/validate')
        .set('Authorization', bearer)
        .send({ code: 'BIGFIX', bookingId: booking.id });

      expect(res.status).toBe(200);
      expect(res.body.discountRub).toBe(1000);
      expect(res.body.totalRub).toBe(0);
    });

    it('404 promoNotFound, 410 promoExpired, 409 promoExhausted', async () => {
      const booking = seedBooking();
      const call = (code: string) =>
        request(app.getHttpServer())
          .post('/api/promos/validate')
          .set('Authorization', bearer)
          .send({ code, bookingId: booking.id });

      const notFound = await call('NOPE');
      expect(notFound.status).toBe(404);
      expect(notFound.body.code).toBe('promoNotFound');

      promosRepo.rows.push(promoRow({ code: 'OLD10', expiresAt: new Date(Date.now() - 1000) }));
      const expired = await call('OLD10');
      expect(expired.status).toBe(410);
      expect(expired.body.code).toBe('promoExpired');

      promosRepo.rows.push(promoRow({ code: 'ZERO', usedCount: 5, maxActivations: 5 }));
      const exhausted = await call('ZERO');
      expect(exhausted.status).toBe(409);
      expect(exhausted.body.code).toBe('promoExhausted');
    });

    it('403 на чужую бронь, 409 если бронь не ждёт оплаты', async () => {
      const booking = seedBooking();
      promosRepo.rows.push(promoRow({ code: 'SHARED10' }));

      const foreign = await request(app.getHttpServer())
        .post('/api/promos/validate')
        .set('Authorization', bearerB)
        .send({ code: 'SHARED10', bookingId: booking.id });
      expect(foreign.status).toBe(403);

      const confirmed = seedBooking({ status: 'CONFIRMED' });
      const notPending = await request(app.getHttpServer())
        .post('/api/promos/validate')
        .set('Authorization', bearer)
        .send({ code: 'SHARED10', bookingId: confirmed.id });
      expect(notPending.status).toBe(409);
      expect(notPending.body.status).toBe('CONFIRMED');
    });
  });

  describe('оплата с промокодом: POST /api/bookings/:id/pay', () => {
    it('200: скидка в totalRub, код и сумма на брони, воркеру — скидочная сумма', async () => {
      published.length = 0;
      const booking = seedBooking();
      promosRepo.rows.push(promoRow({ code: 'PAY10', maxActivations: 1 }));

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({ promoCode: 'pay10' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        totalRub: 900,
        promoCode: 'PAY10',
        discountRub: 100,
      });
      // воркер получает уже скидочную сумму
      expect(published).toEqual([
        expect.objectContaining({
          routingKey: 'booking.created',
          payload: expect.objectContaining({ totalRub: 900 }),
        }),
      ]);
      // активация списана — видно админу
      const used = promosRepo.rows.find((r) => r.code === 'PAY10');
      expect(used?.usedCount).toBe(1);
    });

    it('гонка за последний код: 409 promoExhausted, бронь осталась payable', async () => {
      published.length = 0;
      const booking = seedBooking();
      promosRepo.rows.push(
        promoRow({ code: 'LAST1', maxActivations: 1, usedCount: 1 }),
      );

      const refused = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({ promoCode: 'LAST1' });

      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('promoExhausted');
      expect(published).toEqual([]); // воркеру ничего не ушло

      // транзакция откатилась целиком: бронь всё ещё ждёт оплаты
      const retry = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({});
      expect(retry.status).toBe(200);
      expect(retry.body.totalRub).toBe(1000); // без скидки
    });

    it('404 promoNotFound при оплате, бронь осталась payable', async () => {
      published.length = 0;
      const booking = seedBooking();

      const refused = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({ promoCode: 'GHOST' });

      expect(refused.status).toBe(404);
      expect(refused.body.code).toBe('promoNotFound');

      const retry = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({});
      expect(retry.status).toBe(200);
    });

    it('без промокода — прежнее поведение', async () => {
      const booking = seedBooking();

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'PENDING', totalRub: 1000, promoCode: null });
    });
  });
});

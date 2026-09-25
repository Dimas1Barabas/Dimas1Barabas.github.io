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
import { BonusController } from '../src/bonus/bonus.controller';
import { BonusService } from '../src/bonus/bonus.service';
import {
  BonusKind,
  BonusReason,
  BonusTransaction,
} from '../src/bonus/bonus-transaction.entity';
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
import { RemindersClient } from '../src/reminders/reminders.client';
import { User } from '../src/users/user.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';

/**
 * Интеграционный тест бонусной программы: реальный HTTP-стек Nest
 * (роутинг, ValidationPipe, контроллеры → сервисы, JWT-гвард), но с
 * in-memory фейками Postgres. Ledger-файки честны: вставка уважает
 * uq(booking_id, reason) (ON CONFLICT DO NOTHING), баланс считается
 * от строк SUM'ом, «транзакция» эмулирует ROLLBACK — отказ бонусов
 * оставляет бронь payable и счёт нетронутым.
 */

type LedgerRow = Pick<
  BonusTransaction,
  'id' | 'userId' | 'bookingId' | 'kind' | 'reason' | 'amount' | 'createdAt'
>;

class FakeLedgerRepo {
  rows: LedgerRow[] = [];

  /** история счёта: свои строки, свежие сверху, limit */
  async find(options: {
    where: { userId: string };
    take?: number;
  }): Promise<LedgerRow[]> {
    return this.rows
      .filter((r) => r.userId === options.where.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, options.take ?? 20)
      .map((r) => ({ ...r }));
  }

  /** баланс из BONUS_BALANCE_SQL — от источника, как в реальном PG */
  manager = {
    query: async (
      sql: string,
      params: string[],
    ): Promise<{ balance: string }[]> => {
      if (!sql.includes('FROM bonus_transactions WHERE user_id')) {
        throw new Error(`unexpected query: ${sql}`);
      }
      const balance = this.balanceOf(params[0]);
      // SUM(int) → bigint, pg-драйвер отдаёт строкой
      return [{ balance: String(balance) }];
    },
  };

  balanceOf(userId: string): number {
    return this.rows
      .filter((r) => r.userId === userId)
      .reduce(
        (s, r) => s + (r.kind === 'accrual' ? r.amount : -r.amount),
        0,
      );
  }
}

class FakeBookingRepo {
  rows: Booking[] = [];

  async findOneByOrFail(where: { id: string }): Promise<Booking> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Бронь не найдена');
    return found;
  }

  /** условный UPDATE: criteria.status — как WHERE в реальном PG */
  async update(
    criteria: { id?: string; status?: string },
    patch: Partial<Booking>,
  ): Promise<{ affected: number }> {
    const idx = this.rows.findIndex(
      (r) =>
        r.id === criteria.id &&
        (!criteria.status || r.status === criteria.status),
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
      getRawMany: jest.fn(async () =>
        this.rows.map((r) => ({ status: r.status, count: 1 })),
      ),
    };
  }
}

describe('Бонусы: HTTP-интеграция (фейковые зависимости)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let ledgerRepo: FakeLedgerRepo;
  let bookingsRepo: FakeBookingRepo;
  /** опубликованные в RabbitMQ события */
  let published: { routingKey: string; payload: Record<string, unknown> }[];
  let bookingsService: BookingsService;

  /** Authorization: владелец брони и «чужак» */
  let bearer: string;
  let bearerB: string;

  /** сеанс и фильм фикстуры — контекст брони для события воркеру */
  const sessionId = randomUUID();
  const movieId = randomUUID();

  /** строка ledger'а от прошлой брони */
  const seedLedger = (
    overrides: Partial<LedgerRow> = {},
  ): LedgerRow => {
    const row: LedgerRow = {
      id: randomUUID(),
      userId: 'user-a',
      bookingId: randomUUID(),
      kind: 'accrual',
      reason: 'cashback',
      amount: 500,
      createdAt: new Date(Date.now() - 60_000),
      ...overrides,
    };
    ledgerRepo.rows.push(row);
    return row;
  };

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
    ledgerRepo = new FakeLedgerRepo();
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
    const occupancyRepo = {
      insert: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(async () => []),
    };

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
      // баланс — SUM от строк; разворот при отмене — строки брони
      query: (sql: string, params: string[]) => {
        if (sql.includes('FROM bonus_transactions WHERE user_id')) {
          return Promise.resolve([
            { balance: String(ledgerRepo.balanceOf(params[0])) },
          ]);
        }
        if (sql.includes('SELECT reason, amount FROM bonus_transactions')) {
          return Promise.resolve(
            ledgerRepo.rows
              .filter((r) => r.bookingId === params[0])
              .map((r) => ({ reason: r.reason, amount: r.amount })),
          );
        }
        return Promise.resolve([[], 0]);
      },
      // INSERT … ON CONFLICT (booking_id, reason) DO NOTHING
      createQueryBuilder: () => ({
        insert: () => ({
          into: () => ({
            values: (
              v: {
                userId: string;
                bookingId: string;
                kind: BonusKind;
                reason: BonusReason;
                amount: number;
              },
            ) => ({
              orIgnore: () => ({
                execute: async () => {
                  const dup = ledgerRepo.rows.some(
                    (r) =>
                      r.bookingId === v.bookingId && r.reason === v.reason,
                  );
                  if (dup) return;
                  ledgerRepo.rows.push({
                    id: randomUUID(),
                    createdAt: new Date(),
                    ...v,
                  });
                },
              }),
            }),
          }),
        }),
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [BonusController, BookingsController],
      providers: [
        BonusService,
        BookingsService,
        BookingStream,
        SeatStream,
        { provide: getRepositoryToken(BonusTransaction), useValue: ledgerRepo },
        // pay() спрашивает промокод только после отката — всегда «не найден»
        { provide: getRepositoryToken(Promo), useValue: { findOneBy: jest.fn(async () => null) } },
        // create() гасит запись листа ожидания — фейку достаточно update
        { provide: getRepositoryToken(WaitlistEntry), useValue: { update: jest.fn(async () => ({ affected: 0 })) } },
        // email адресата «письма»-напоминания + gRPC-клиент reminder'ов
        { provide: getRepositoryToken(User), useValue: { findOneByOrFail: jest.fn() } },
        { provide: RemindersClient, useValue: { schedule: jest.fn(async () => ({ status: 'SCHEDULED' })), cancel: jest.fn(async () => ({ status: 'CANCELLED' })) } },
        // Тарификатор: базовая цена без факторов (ценовые кейсы — в pricing.int)
        { provide: PricingClient, useValue: { quote: jest.fn(async (input: { basePriceRub: number }) => ({ priceRub: input.basePriceRub, basePriceRub: input.basePriceRub, factors: [], occupied: 0, capacity: 80 })) } },
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
            // перечитывание баланса в сообщении отказа (bonusRefusalError)
            manager: { query: em.query },
            /**
             * «Транзакция» с честным ROLLBACK: на входе снимаем состояние
             * броней и ledger'а, при броске callback — возвращаем как было.
             * Иначе отказ бонусов не доказал бы «счёт не тронут».
             */
            transaction: async (cb: (e: typeof em) => unknown) => {
              const bookingsSnap = bookingsRepo.rows.map((r) => ({ ...r }));
              const ledgerSnap = ledgerRepo.rows.map((r) => ({ ...r }));
              try {
                return await cb(em);
              } catch (err) {
                bookingsRepo.rows.splice(
                  0,
                  bookingsRepo.rows.length,
                  ...bookingsSnap.map((r) => ({ ...r })),
                );
                ledgerRepo.rows.splice(
                  0,
                  ledgerRepo.rows.length,
                  ...ledgerSnap.map((r) => ({ ...r })),
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
    bookingsService = moduleRef.get(BookingsService);

    const jwt = moduleRef.get(JwtService);
    const sign = (sub: string, name: string, role: 'user' | 'admin') =>
      jwt.signAsync({ sub, email: `${sub}@test.local`, name, role });
    bearer = `Bearer ${await sign('user-a', 'Анна Тест', 'user')}`;
    bearerB = `Bearer ${await sign('user-b', 'Борис Чужой', 'user')}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/bonuses/my', () => {
    it('401 без токена', async () => {
      const res = await request(app.getHttpServer()).get('/api/bonuses/my');

      expect(res.status).toBe(401);
    });

    it('пустой счёт: баланс 0, история пустая', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/bonuses/my')
        .set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ balance: 0, transactions: [] });
    });

    it('баланс считается от источников, история — свежими сверху', async () => {
      seedLedger({ amount: 500 });
      seedLedger({
        kind: 'spend',
        reason: 'payment',
        amount: 200,
        createdAt: new Date(Date.now() - 30_000),
      });

      const res = await request(app.getHttpServer())
        .get('/api/bonuses/my')
        .set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(300);
      expect(res.body.transactions).toHaveLength(2);
      expect(res.body.transactions[0]).toMatchObject({
        kind: 'spend',
        reason: 'payment',
        amount: 200,
      });
    });

    it('limit режет историю', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/bonuses/my?limit=1')
        .set('Authorization', bearer);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(1);
    });

    it('чужой счёт не виден: user-b видит свои нули', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/bonuses/my')
        .set('Authorization', bearerB);

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(0);
    });
  });

  describe('POST /api/bookings/:id/pay с useBonuses', () => {
    // гонки и отказы считают баланс «до/после» — тестируем на чистом счёте
    beforeEach(() => {
      ledgerRepo.rows.length = 0;
      bookingsRepo.rows.length = 0;
    });

    it('списывает: итог меньше, spend-строка в истории, воркеру — финальная сумма', async () => {
      seedLedger({ amount: 500 }); // баланс 500
      const booking = seedBooking();

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({ useBonuses: 300 });

      expect(res.status).toBe(200);
      // 1000 − 300 бонусов = 700
      expect(res.body).toMatchObject({
        status: 'PENDING',
        totalRub: 700,
        bonusSpent: 300,
      });
      expect(published.at(-1)).toMatchObject({
        routingKey: 'booking.created',
        payload: expect.objectContaining({ totalRub: 700 }),
      });

      const account = await request(app.getHttpServer())
        .get('/api/bonuses/my')
        .set('Authorization', bearer);
      expect(account.body.balance).toBe(200);
      expect(account.body.transactions[0]).toMatchObject({
        kind: 'spend',
        reason: 'payment',
        amount: 300,
        bookingId: booking.id,
      });
    });

    it('409 bonusOverLimit: больше половины чека — счёт и бронь не тронуты', async () => {
      seedLedger({ amount: 5000 });
      const booking = seedBooking();

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({ useBonuses: 600 }); // лимит 500

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bonusOverLimit');
      // ROLLBACK: бронь осталась ждать оплаты, баланс цел
      expect(bookingsRepo.rows.at(-1)?.status).toBe('PENDING_PAYMENT');
      expect(ledgerRepo.balanceOf('user-a')).toBe(5000);
    });

    it('409 bonusInsufficient: баланса меньше запрошенного', async () => {
      seedLedger({ amount: 100 });
      const booking = seedBooking();

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({ useBonuses: 300 }); // лимит ок, баланса нет

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bonusInsufficient');
      expect(ledgerRepo.balanceOf('user-a')).toBe(100);
    });

    it('409 bonusUnavailable: гостевая бронь без владельца', async () => {
      seedLedger({ amount: 500 });
      const booking = seedBooking({ userId: null });

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/pay`)
        .set('Authorization', bearer)
        .send({ useBonuses: 100 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bonusUnavailable');
    });

    it('400 на кривое useBonuses (0 / дробь / строка)', async () => {
      const booking = seedBooking();
      const api = request(app.getHttpServer());

      for (const bad of [0, 1.5, 'много']) {
        const res = await api
          .post(`/api/bookings/${booking.id}/pay`)
          .set('Authorization', bearer)
          .send({ useBonuses: bad });
        expect(res.status).toBe(400);
      }
      // бронь так и не оплачена — все попытки отвергнуты валидацией
      expect(bookingsRepo.rows.at(-1)?.status).toBe('PENDING_PAYMENT');
    });
  });

  describe('вердикты воркера: кэшбэк и развороты', () => {
    beforeEach(() => {
      ledgerRepo.rows.length = 0;
      bookingsRepo.rows.length = 0;
    });

    const processed = (booking: Booking, status: 'CONFIRMED' | 'FAILED') =>
      bookingsService.handleProcessed({
        bookingId: booking.id,
        status,
        message: status === 'CONFIRMED' ? 'Оплата прошла' : 'Платёж отклонён',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

    it('CONFIRMED начисляет кэшбэк 5% — виден в счёте', async () => {
      const booking = seedBooking({ status: 'PENDING' });
      await processed(booking, 'CONFIRMED');

      const cashback = ledgerRepo.rows.find(
        (r) => r.bookingId === booking.id && r.reason === 'cashback',
      );
      // floor(1000 × 5%) = 50
      expect(cashback).toMatchObject({
        kind: 'accrual',
        amount: 50,
        userId: 'user-a',
      });

      const account = await request(app.getHttpServer())
        .get('/api/bonuses/my')
        .set('Authorization', bearer);
      expect(account.body.transactions[0]).toMatchObject({
        reason: 'cashback',
        amount: 50,
      });
    });

    it('ределивери CONFIRMED не задваивает кэшбэк (uq booking+reason)', async () => {
      const booking = seedBooking({ status: 'PENDING' });

      await processed(booking, 'CONFIRMED');
      // бронь уже CONFIRMED — вердикт-дубль просто пропустится
      await processed(booking, 'CONFIRMED');

      const cashbacks = ledgerRepo.rows.filter(
        (r) => r.bookingId === booking.id && r.reason === 'cashback',
      );
      expect(cashbacks).toHaveLength(1);
    });

    it('FAILED возвращает списанное при оплате', async () => {
      const booking = seedBooking({
        status: 'PENDING',
        bonusSpent: 300,
        totalRub: 700,
      });

      await processed(booking, 'FAILED');

      expect(
        ledgerRepo.rows.find(
          (r) => r.bookingId === booking.id && r.reason === 'payment_failed',
        ),
      ).toMatchObject({ kind: 'accrual', amount: 300 });
    });

    it('CANCELLED: списанное вернулось, кэшбэк погасился', async () => {
      const booking = seedBooking({ status: 'CANCELLING' });
      ledgerRepo.rows.push(
        {
          id: randomUUID(),
          userId: 'user-a',
          bookingId: booking.id,
          kind: 'spend',
          reason: 'payment',
          amount: 300,
          createdAt: new Date(Date.now() - 120_000),
        },
        {
          id: randomUUID(),
          userId: 'user-a',
          bookingId: booking.id,
          kind: 'accrual',
          reason: 'cashback',
          amount: 35,
          createdAt: new Date(Date.now() - 60_000),
        },
      );

      await bookingsService.handleRefunded({
        bookingId: booking.id,
        status: 'CANCELLED',
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      expect(
        ledgerRepo.rows.find((r) => r.bookingId === booking.id && r.reason === 'refund'),
      ).toMatchObject({ kind: 'accrual', amount: 300 });
      // баланс к гашению: −300 + 35 + 300 = 35 → весь кэшбэк
      expect(
        ledgerRepo.rows.find((r) => r.bookingId === booking.id && r.reason === 'clawback'),
      ).toMatchObject({ kind: 'spend', amount: 35 });
    });
  });
});

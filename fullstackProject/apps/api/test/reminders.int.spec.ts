import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { DataSource } from 'typeorm';
import { Booking } from '../src/bookings/booking.entity';
import { BookingStream } from '../src/bookings/booking-stream';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingsService } from '../src/bookings/bookings.service';
import { SeatStream } from '../src/bookings/seat-stream';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { BonusTransaction } from '../src/bonus/bonus-transaction.entity';
import { Movie } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { Promo } from '../src/promos/promo.entity';
import { PricingClient } from '../src/pricing/pricing.client';
import { RateLimiterClient } from '../src/ratelimiter/ratelimiter.client';
import { RemindersClient } from '../src/reminders/reminders.client';
import { RemindersConsumer } from '../src/reminders/reminders.consumer';
import { User } from '../src/users/user.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';
import type { AddressInfo } from 'node:net';
import { sseFrames, waitForSseEvent } from './sse';

/**
 * Интеграция напоминаний: вердиктные хуки BookingsService зовут
 * gRPC-клиент (фейк), а RemindersConsumer разгоняет событие
 * «письмо ушло» в SSE-кадр `reminder` реального стрима.
 */

const futureSession: Session = {
  id: 'session-1',
  movieId: 'movie-1',
  movie: {} as Movie,
  hall: 'IMAX',
  startsAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
  createdAt: new Date(),
};

const movieFixture: Movie = {
  id: 'movie-1',
  title: 'Рекурсия',
  description: '',
  genre: 'хоррор',
  genreIcon: '🌀',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  sessions: [],
  ratingAvg: 0,
  ratingCount: 0,
  createdAt: new Date(),
};

function pendingBooking(): Booking {
  return {
    id: 'booking-1',
    movieId: 'movie-1',
    movie: movieFixture,
    sessionId: 'session-1',
    session: futureSession,
    customerName: 'Дмитрий',
    userId: 'user-1',
    seats: ['5-7', '5-8'],
    totalRub: 800,
    promoCode: null,
    discountRub: null,
    bonusSpent: null,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    message: null,
    processedBy: null,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** даём fire-and-forget промисам (планирование напоминания) доделать тик */
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Reminders (integration)', () => {
  let app: INestApplication;
  let service: BookingsService;
  let consumer: RemindersConsumer;
  let reminders: { schedule: jest.Mock; cancel: jest.Mock };
  let bookingsRepo: {
    save: jest.Mock;
    findOneByOrFail: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeAll(async () => {
    bookingsRepo = {
      // save эмулирует БД: возвращает записанное
      save: jest.fn(async (x: Partial<Booking>) => x),
      findOneByOrFail: jest.fn(async () => pendingBooking()),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    // «транзакция» сразу выполняет callback с эмуляцией EntityManager;
    // insert-QB — кэшбэк CONFIRMED-брони, query — разворот бонусов возврата
    const em = {
      findOneByOrFail: (entity: unknown, where: { id: string }) =>
        entity === Booking
          ? bookingsRepo.findOneByOrFail(where)
          : entity === Session
            ? Promise.resolve(futureSession)
            : Promise.resolve(movieFixture),
      save: (_entity: unknown, x: Booking) => bookingsRepo.save(x),
      query: jest.fn(async () => [[], 0]),
      createQueryBuilder: () => ({
        insert: () => ({
          into: (entity: unknown) => {
            if (entity !== BonusTransaction) {
              throw new Error(`Неожиданный insert-QB в тесте: ${String(entity)}`);
            }
            return {
              values: () => ({
                orIgnore: () => ({ execute: async () => undefined }),
              }),
            };
          },
        }),
      }),
    };

    reminders = {
      schedule: jest.fn(async () => ({ status: 'SCHEDULED', dueAt: '2026-09-25T17:00:00Z' })),
      cancel: jest.fn(async () => ({ status: 'CANCELLED' })),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BookingsController],
      providers: [
        BookingsService,
        BookingStream,
        SeatStream,
        RemindersConsumer,
        { provide: RemindersClient, useValue: reminders },
        // Тарификатор: базовая цена без факторов (ценовые кейсы — в pricing.int)
        { provide: PricingClient, useValue: { quote: jest.fn(async (input: { basePriceRub: number }) => ({ priceRub: input.basePriceRub, basePriceRub: input.basePriceRub, factors: [], occupied: 0, capacity: 80 })) } },
        { provide: RateLimiterClient, useValue: { check: jest.fn(async () => ({ allowed: true })) } },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        {
          provide: getRepositoryToken(Movie),
          useValue: { findOneByOrFail: jest.fn(async () => movieFixture) },
        },
        {
          provide: getRepositoryToken(Session),
          useValue: { findOneByOrFail: jest.fn(async () => futureSession) },
        },
        {
          provide: getRepositoryToken(SeatOccupancy),
          useValue: { find: jest.fn(async () => []), delete: jest.fn() },
        },
        {
          provide: getRepositoryToken(Promo),
          useValue: { findOneBy: jest.fn(async () => null) },
        },
        {
          provide: getRepositoryToken(WaitlistEntry),
          useValue: { update: jest.fn(async () => ({ affected: 0 })) },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOneByOrFail: jest.fn(async () => ({
              id: 'user-1',
              email: 'viewer@example.com',
            })),
          },
        },
        { provide: AmqpConnection, useValue: { publish: jest.fn(), connected: true } },
        {
          provide: DataSource,
          useValue: {
            transaction: (cb: (e: typeof em) => unknown) => cb(em),
            manager: { query: jest.fn(async () => []) },
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    service = moduleRef.get(BookingsService);
    consumer = moduleRef.get(RemindersConsumer);
  });

  afterAll(async () => {
    await app.close();
  });

  it('вердикт CONFIRMED будущего сеанса планирует напоминание с email владельца', async () => {
    await service.handleProcessed({
      bookingId: 'booking-1',
      status: 'CONFIRMED',
      message: 'Оплата прошла',
      processedBy: 'go-worker-1',
      processedAt: new Date().toISOString(),
    });
    await flushAsync();

    expect(reminders.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'booking-1',
        userId: 'user-1',
        email: 'viewer@example.com',
        movieTitle: 'Рекурсия',
        hall: 'IMAX',
        seats: ['5-7', '5-8'],
      }),
    );
  });

  it('сага возврата CANCELLED гасит напоминание', async () => {
    bookingsRepo.findOneByOrFail.mockResolvedValue({
      ...pendingBooking(),
      status: 'CANCELLING',
    });

    await service.handleRefunded({
      bookingId: 'booking-1',
      status: 'CANCELLED',
      message: 'Возврат зачислен',
      processedBy: 'go-worker-1',
      processedAt: new Date().toISOString(),
    });
    await flushAsync();

    expect(reminders.cancel).toHaveBeenCalledWith('booking-1');
  });

  it('событие «письмо ушло» становится SSE-кадром reminder (без email)', async () => {
    await app.listen(0);
    const address = app.getHttpServer().address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const controller = new AbortController();
    const res = await fetch(`${base}/api/bookings/stream`, {
      signal: controller.signal,
    });
    expect(res.ok).toBe(true);

    const frames = sseFrames(res.body!);
    const emitting = consumer.onReminderSent({
      email: 'viewer@example.com',
      userId: 'user-1',
      bookingId: 'booking-1',
      movieId: 'movie-1',
      movieTitle: 'Рекурсия',
      hall: 'IMAX',
      sessionAt: futureSession.startsAt.toISOString(),
      seats: ['5-7', '5-8'],
      remindedAt: new Date().toISOString(),
      message: 'Скоро сеанс: «Рекурсия»…',
    });

    const payload = await waitForSseEvent<{
      userId: string;
      bookingId: string;
      movieTitle: string;
      email?: string;
    }>(frames, 'reminder', (p) => p.bookingId === 'booking-1');
    await emitting;

    expect(payload.userId).toBe('user-1');
    expect(payload.movieTitle).toBe('Рекурсия');
    expect(payload.email).toBeUndefined(); // стрим публичен — адресата не светим

    controller.abort();
    await app.close();
  });
});

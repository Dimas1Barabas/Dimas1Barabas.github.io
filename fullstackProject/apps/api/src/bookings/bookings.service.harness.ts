/**
 * Харнесс юнит-спек BookingsService (доменные файлы bookings.*.spec.ts):
 * фикстуры и полный набор фейков (репозитории, транзакция-EntityManager,
 * gRPC-клиенты, шины) — тот же сетап, что был общим beforeEach
 * одного большого файла. Каждый доменный спек деструктурирует нужное.
 */
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { Movie } from '../movies/movie.entity';
import { Promo } from '../promos/promo.entity';
import { PricingClient } from '../pricing/pricing.client';
import { RemindersClient } from '../reminders/reminders.client';
import { User } from '../users/user.entity';
import { WaitlistEntry } from '../waitlist/waitlist.entity';
import { Session } from '../movies/session.entity';
import { Booking } from './booking.entity';
import { BookingStream } from './booking-stream';
import { BookingsService } from './bookings.service';
import { SeatStream } from './seat-stream';
import { SeatOccupancy } from './seat-occupancy.entity';

export const movieFixture: Movie = {
  id: 'movie-1',
  title: 'Рекурсия',
  description: 'desc',
  genre: 'хоррор',
  genreIcon: '🌀',
  durationMin: 112,
  priceRub: 400,
  hue: 275,
  sessions: [],
  ratingAvg: 0,
  ratingCount: 0,
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

export const sessionFixture: Session = {
  id: 'session-1',
  movieId: 'movie-1',
  movie: movieFixture,
  hall: 'IMAX',
  startsAt: new Date('2026-09-05T19:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

/** владелец брони из JWT (совпадает с userId фикстуры) */
export const authUser: AuthUser = {
  id: 'user-1',
  email: 'dmitry@example.com',
  name: 'Дмитрий',
  role: 'user',
};

export function bookingFixture(): Booking {
  return {
    id: 'booking-1',
    movieId: movieFixture.id,
    movie: movieFixture,
    sessionId: sessionFixture.id,
    session: sessionFixture,
    customerName: 'Дмитрий',
    userId: 'user-1',
    seats: ['5-7', '5-8', '5-9'],
    totalRub: 1200,
    promoCode: null,
    discountRub: null,
    bonusSpent: null,
    status: 'PENDING',
    expiresAt: new Date('2026-09-03T12:15:00Z'),
    message: null,
    processedBy: null,
    processedAt: null,
    createdAt: new Date('2026-09-03T12:00:00Z'),
    updatedAt: new Date('2026-09-03T12:00:00Z'),
  };
}

/** даём fire-and-forget промисам (планирование напоминания) доделать тик */
export const flushAsync = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface BookingsHarness {
  service: BookingsService;
  bookingsRepo: {
    save: jest.Mock;
    find: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  moviesRepo: { findOneByOrFail: jest.Mock };
  sessionsRepo: { findOneByOrFail: jest.Mock };
  occupancyRepo: { find: jest.Mock; delete: jest.Mock };
  promosRepo: { findOneBy: jest.Mock };
  waitlistRepo: { update: jest.Mock };
  /** email адресата «письма»-напоминания (scheduleReminder) */
  usersRepo: { findOneByOrFail: jest.Mock };
  /** gRPC-клиент напоминаний: спаем schedule/call'ы вердиктных хуков */
  reminders: { schedule: jest.Mock; cancel: jest.Mock };
  /** gRPC-клиент Тарификатора: по умолчанию отвечает базовой ценой */
  pricing: { quote: jest.Mock };
  rabbit: { publish: jest.Mock };
  /** SSE-шина: спаем, что после мутаций ушли события */
  stream: { emit: jest.Mock };
  /** шина живой карты мест: сигнал на каждое изменение занятости */
  seatStream: { emit: jest.Mock };
  /** что «INSERT INTO seat_occupancy» сделал внутри транзакции */
  emInsert: jest.Mock;
  /** что «UPDATE …» сделал внутри транзакции (pay: статус + скидка) */
  emUpdate: jest.Mock;
  /** что сырые SQL-запросы вернули внутри транзакции (промо/баланс) */
  emQuery: jest.Mock;
  /** фейковый ledger: строки bonus_transactions «в БД» */
  bonusRows: Array<{
    userId: string;
    bookingId: string;
    kind: string;
    reason: string;
    amount: number;
  }>;
}

export async function buildBookingsHarness(): Promise<BookingsHarness> {
  const bookingsRepo: BookingsHarness['bookingsRepo'] = {
    // merge с фикстурой эмулирует БД: проставляет createdAt/updatedAt
    save: jest.fn(async (x: Partial<Booking>) => ({ ...bookingFixture(), ...x })),
    find: jest.fn(),
    // verifyTicket ищет мягко: не нашёл — вердикт bookingNotFound, не 404
    findOneBy: jest.fn(),
    findOneByOrFail: jest.fn(),
    // условный UPDATE … WHERE status='CONFIRMED' по умолчанию проходит
    update: jest.fn(async () => ({ affected: 1 })),
    // GROUP BY по статусам: по умолчанию пустая выборка
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    })),
  };
  const moviesRepo: BookingsHarness['moviesRepo'] = {
    findOneByOrFail: jest.fn(async () => movieFixture),
  };
  const sessionsRepo: BookingsHarness['sessionsRepo'] = {
    findOneByOrFail: jest.fn(async () => sessionFixture),
  };
  const occupancyRepo: BookingsHarness['occupancyRepo'] = {
    find: jest.fn(async () => []),
    delete: jest.fn(),
  };
  const promosRepo: BookingsHarness['promosRepo'] = {
    findOneBy: jest.fn(async () => null),
  };
  const waitlistRepo: BookingsHarness['waitlistRepo'] = {
    update: jest.fn(async () => ({ affected: 0 })),
  };
  const usersRepo: BookingsHarness['usersRepo'] = {
    findOneByOrFail: jest.fn(async () => ({
      id: 'user-1',
      email: 'dmitry@example.com',
    })),
  };
  const reminders: BookingsHarness['reminders'] = {
    schedule: jest.fn(async () => ({ status: 'SCHEDULED', dueAt: '2026-09-25T17:00:00Z' })),
    cancel: jest.fn(async () => ({ status: 'CANCELLED' })),
  };
  // Тарификатор по умолчанию «прозрачен»: базовая цена без факторов —
  // кейсы ценообразования переключают мок точечно
  const pricing: BookingsHarness['pricing'] = {
    quote: jest.fn(async () => ({
      priceRub: movieFixture.priceRub,
      basePriceRub: movieFixture.priceRub,
      factors: [],
      occupied: 0,
      capacity: 80,
    })),
  };
  const rabbit: BookingsHarness['rabbit'] = { publish: jest.fn() };
  const stream: BookingsHarness['stream'] = { emit: jest.fn() };
  const seatStream: BookingsHarness['seatStream'] = { emit: jest.fn() };
  const emInsert = jest.fn(async () => undefined);
  // условный UPDATE по умолчанию проходит (affected = 1)
  const emUpdate = jest.fn(async () => ({ affected: 1 }));
  const bonusRows: BookingsHarness['bonusRows'] = [];
  // сырой SQL по содержимому: баланс/строки ledger'а считаются от
  // фейковых bonusRows (SUM в pg — bigint, драйвер отдаёт строкой),
  // UPDATE … RETURNING промокода — кортеж [строки, число затронутых]
  const emQuery = jest.fn(async (sql: string, params: unknown[]) => {
    if (/FROM bonus_transactions WHERE user_id/.test(sql)) {
      const balance = bonusRows
        .filter((r) => r.userId === params[0])
        .reduce((s, r) => s + (r.kind === 'accrual' ? r.amount : -r.amount), 0);
      return [{ balance: String(balance) }];
    }
    if (/SELECT reason, amount FROM bonus_transactions/.test(sql)) {
      return bonusRows
        .filter((r) => r.bookingId === params[0])
        .map((r) => ({ reason: r.reason, amount: r.amount }));
    }
    return [[], 0];
  });

  // «транзакция» сразу выполняет callback с эмуляцией EntityManager:
  // insert может упасть с pg-кодом 23505 — как настоящий констрейнт
  const em: {
    findOneByOrFail: (
      entity: unknown,
      where: { id: string },
    ) => Promise<unknown>;
    create: (entity: unknown, x: Partial<Booking>) => Partial<Booking>;
    save: (entity: unknown, x: Booking) => Promise<Booking>;
    insert: jest.Mock;
    update: jest.Mock;
    /** гашение занятости в транзакции (handleExpired) */
    delete: (
      entity: unknown,
      criteria: { bookingId: string },
    ) => Promise<unknown>;
    query: jest.Mock;
    createQueryBuilder: (entity: unknown) => unknown;
  } = {
    findOneByOrFail: (entity, where) =>
      entity === Booking
        ? bookingsRepo.findOneByOrFail(where)
        : entity === Session
          ? sessionsRepo.findOneByOrFail(where)
          : moviesRepo.findOneByOrFail(where),
    create: (_entity, x) => x,
    save: (_entity, x) => bookingsRepo.save(x),
    insert: emInsert,
    update: emUpdate,
    // handleExpired гасит занятость в общей транзакции со статусом
    delete: (_entity: unknown, criteria: { bookingId: string }) =>
      occupancyRepo.delete(criteria),
    query: emQuery,
    // INSERT INTO bonus_transactions … ON CONFLICT DO NOTHING:
    // orIgnore-цепочка пишет строку в фейковый ledger
    createQueryBuilder: () => ({
      insert: () => ({
        into: (entity: unknown) => {
          if (entity !== BonusTransaction) {
            throw new Error(
              `Неожиданный insert-QB в тесте: ${String(entity)}`,
            );
          }
          return {
            values: (v: (typeof bonusRows)[number]) => ({
              orIgnore: () => ({
                execute: async () => {
                  bonusRows.push(v);
                },
              }),
            }),
          };
        },
      }),
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      BookingsService,
      {
        provide: DataSource,
        // manager — для перечитывания баланса в сообщении отказа
        useValue: {
          transaction: (cb: (e: typeof em) => unknown) => cb(em),
          manager: { query: emQuery },
        },
      },
      { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
      { provide: getRepositoryToken(Movie), useValue: moviesRepo },
      { provide: getRepositoryToken(Session), useValue: sessionsRepo },
      { provide: getRepositoryToken(SeatOccupancy), useValue: occupancyRepo },
      { provide: getRepositoryToken(Promo), useValue: promosRepo },
      // create() гасит запись листа ожидания — фейку достаточно update
      { provide: getRepositoryToken(WaitlistEntry), useValue: waitlistRepo },
      // email адресата напоминания
      { provide: getRepositoryToken(User), useValue: usersRepo },
      { provide: RemindersClient, useValue: reminders },
      { provide: PricingClient, useValue: pricing },
      { provide: AmqpConnection, useValue: rabbit },
      { provide: BookingStream, useValue: stream },
      { provide: SeatStream, useValue: seatStream },
    ],
  }).compile();

  return {
    service: moduleRef.get(BookingsService),
    bookingsRepo,
    moviesRepo,
    sessionsRepo,
    occupancyRepo,
    promosRepo,
    waitlistRepo,
    usersRepo,
    reminders,
    pricing,
    rabbit,
    stream,
    seatStream,
    emInsert,
    emUpdate,
    emQuery,
    bonusRows,
  };
}

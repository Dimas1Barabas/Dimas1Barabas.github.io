import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
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
import { Booking, BookingStatus } from './booking.entity';
import { BookingStream } from './booking-stream';
import { BookingsService } from './bookings.service';
import { SeatStream } from './seat-stream';
import { SeatOccupancy } from './seat-occupancy.entity';
import { CreateBookingDto } from './dto/create-booking.dto';
import { signTicket, ticketCanonical } from './ticket.logic';

const movieFixture: Movie = {
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

const sessionFixture: Session = {
  id: 'session-1',
  movieId: 'movie-1',
  movie: movieFixture,
  hall: 'IMAX',
  startsAt: new Date('2026-09-05T19:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

/** владелец брони из JWT (совпадает с userId фикстуры) */
const authUser: AuthUser = {
  id: 'user-1',
  email: 'dmitry@example.com',
  name: 'Дмитрий',
  role: 'user',
};

function bookingFixture(): Booking {
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
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('BookingsService (unit)', () => {
  let service: BookingsService;
  let bookingsRepo: {
    save: jest.Mock;
    find: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let moviesRepo: { findOneByOrFail: jest.Mock };
  let sessionsRepo: { findOneByOrFail: jest.Mock };
  let occupancyRepo: { find: jest.Mock; delete: jest.Mock };
  let promosRepo: { findOneBy: jest.Mock };
  let waitlistRepo: { update: jest.Mock };
  /** email адресата «письма»-напоминания (scheduleReminder) */
  let usersRepo: { findOneByOrFail: jest.Mock };
  /** gRPC-клиент напоминаний: спаем schedule/call'ы вердиктных хуков */
  let reminders: { schedule: jest.Mock; cancel: jest.Mock };
  /** gRPC-клиент Тарификатора: по умолчанию отвечает базовой ценой */
  let pricing: { quote: jest.Mock };
  let rabbit: { publish: jest.Mock };
  /** SSE-шина: спаем, что после мутаций ушли события */
  let stream: { emit: jest.Mock };
  /** шина живой карты мест: сигнал на каждое изменение занятости */
  let seatStream: { emit: jest.Mock };
  /** что «INSERT INTO seat_occupancy» сделал внутри транзакции */
  let emInsert: jest.Mock;
  /** что «UPDATE …» сделал внутри транзакции (pay: статус + скидка) */
  let emUpdate: jest.Mock;
  /** что сырые SQL-запросы вернули внутри транзакции (промо/баланс) */
  let emQuery: jest.Mock;
  /** фейковый ledger: строки bonus_transactions «в БД» */
  let bonusRows: Array<{
    userId: string;
    bookingId: string;
    kind: string;
    reason: string;
    amount: number;
  }>;

  beforeEach(async () => {
    bookingsRepo = {
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
    moviesRepo = { findOneByOrFail: jest.fn(async () => movieFixture) };
    sessionsRepo = { findOneByOrFail: jest.fn(async () => sessionFixture) };
    occupancyRepo = { find: jest.fn(async () => []), delete: jest.fn() };
    promosRepo = { findOneBy: jest.fn(async () => null) };
    waitlistRepo = { update: jest.fn(async () => ({ affected: 0 })) };
    usersRepo = {
      findOneByOrFail: jest.fn(async () => ({
        id: 'user-1',
        email: 'dmitry@example.com',
      })),
    };
    reminders = {
      schedule: jest.fn(async () => ({ status: 'SCHEDULED', dueAt: '2026-09-25T17:00:00Z' })),
      cancel: jest.fn(async () => ({ status: 'CANCELLED' })),
    };
    // Тарификатор по умолчанию «прозрачен»: базовая цена без факторов —
    // кейсы ценообразования переключают мок точечно
    pricing = {
      quote: jest.fn(async () => ({
        priceRub: movieFixture.priceRub,
        basePriceRub: movieFixture.priceRub,
        factors: [],
        occupied: 0,
        capacity: 80,
      })),
    };
    rabbit = { publish: jest.fn() };
    stream = { emit: jest.fn() };
    seatStream = { emit: jest.fn() };
    emInsert = jest.fn(async () => undefined);
    // условный UPDATE по умолчанию проходит (affected = 1)
    emUpdate = jest.fn(async () => ({ affected: 1 }));
    bonusRows = [];
    // сырой SQL по содержимому: баланс/строки ledger'а считаются от
    // фейковых bonusRows (SUM в pg — bigint, драйвер отдаёт строкой),
    // UPDATE … RETURNING промокода — кортеж [строки, число затронутых]
    emQuery = jest.fn(async (sql: string, params: unknown[]) => {
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

    service = moduleRef.get(BookingsService);
  });

  describe('create', () => {
    it('сохраняет PENDING_PAYMENT-бронь с дедлайном оплаты и суммой', async () => {
      const dto: CreateBookingDto = {
        sessionId: 'session-1',
        customerName: 'Дмитрий',
        seats: ['5-7', '5-8', '5-9'],
      };

      const result = await service.create(dto, authUser);

      expect(result.status).toBe('PENDING_PAYMENT');
      // дедлайн — стандартное окно оплаты (15 мин) от создания
      expect(result.expiresAt).toBeTruthy();
      const skewMs = Math.abs(
        Date.parse(result.expiresAt!) - Date.now() - 15 * 60_000,
      );
      expect(skewMs).toBeLessThan(60_000);
      expect(result.totalRub).toBe(1200); // 400 × 3
      expect(result.movieTitle).toBe('Рекурсия');
      expect(result.sessionId).toBe('session-1');
      expect(result.hall).toBe('IMAX');
      expect(result.sessionAt).toBe('2026-09-05T19:00:00.000Z');
      expect(result.seats).toEqual(['5-7', '5-8', '5-9']);
    });

    it('гасит запись в листе ожидания этого сеанса — create → LEFT', async () => {
      const dto: CreateBookingDto = {
        sessionId: 'session-1',
        customerName: 'Дмитрий',
        seats: ['5-7'],
      };

      await service.create(dto, authUser);

      expect(waitlistRepo.update).toHaveBeenCalledWith(
        { sessionId: 'session-1', userId: authUser.id },
        { status: 'LEFT' },
      );
    });

    it('фильм выводит из сеанса — бронь привязана к обоим', async () => {
      await service.create(
        { sessionId: 'session-1', seats: ['1-1'] },
        authUser,
      );

      expect(sessionsRepo.findOneByOrFail).toHaveBeenCalledWith({
        id: 'session-1',
      });
      expect(moviesRepo.findOneByOrFail).toHaveBeenCalledWith({
        id: 'movie-1', // movieId взят из сеанса
      });
    });

    it('имя покупателя берёт из JWT, если customerName не передан', async () => {
      const result = await service.create(
        { sessionId: 'session-1', seats: ['1-1'] },
        authUser,
      );

      expect(result.customerName).toBe('Дмитрий');
      expect(result.userId).toBe('user-1');
    });

    it('занимает места строками занятости сеанса в той же транзакции', async () => {
      await service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['5-7'],
        },
        authUser,
      );

      expect(emInsert).toHaveBeenCalledWith(
        SeatOccupancy,
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 'session-1', seat: '5-7' }),
        ]),
      );
    });

    it('публикует booking.payment.wait — запускает таймер резерва', async () => {
      const result = await service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['5-7', '5-8', '5-9'],
        },
        authUser,
      );

      expect(rabbit.publish).toHaveBeenCalledTimes(1);
      const [exchange, routingKey, event] = rabbit.publish.mock.calls[0];
      expect(exchange).toBe('cinema');
      expect(routingKey).toBe('booking.payment.wait');
      expect(event).toMatchObject({
        bookingId: result.id,
        totalRub: 1200,
        expiresAt: result.expiresAt,
      });
    });

    it('цена брони — от Тарификатора: квот с факторами до транзакции', async () => {
      pricing.quote.mockResolvedValueOnce({
        priceRub: 480, // вечер +20%
        basePriceRub: 400,
        factors: [{ code: 'evening', label: 'вечерний прайм +20%', percent: 20 }],
        occupied: 12,
        capacity: 80,
      });

      const result = await service.create(
        { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['5-7', '5-8'] },
        authUser,
      );

      expect(pricing.quote).toHaveBeenCalledWith({
        sessionId: 'session-1',
        sessionAt: sessionFixture.startsAt.toISOString(),
        basePriceRub: 400,
        capacity: 80,
      });
      expect(result.totalRub).toBe(960); // 480 × 2
      // спрос Тарификатора: wait-событие несёт сеанс и число мест
      const event = rabbit.publish.mock.calls[0][2];
      expect(event).toMatchObject({ sessionId: 'session-1', seatsCount: 2 });
    });

    it('недоступность Тарификатора — базовая цена, бронь жива', async () => {
      pricing.quote.mockRejectedValueOnce(new Error('deadline exceeded'));

      const result = await service.create(
        { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['5-7'] },
        authUser,
      );

      expect(result.totalRub).toBe(400); // база афиши × 1 место
      expect(result.status).toBe('PENDING_PAYMENT');
    });

    it('мусор в ответе Тарификатора — тоже базовая цена', async () => {
      pricing.quote.mockResolvedValueOnce({ priceRub: -50 });

      const result = await service.create(
        { sessionId: 'session-1', seats: ['5-7'] },
        authUser,
      );

      expect(result.totalRub).toBe(400);
    });

    it('обрезает пробелы вокруг имени', async () => {
      const result = await service.create(
        {
          sessionId: 'session-1',
          customerName: '  Дмитрий  ',
          seats: ['1-1'],
        },
        authUser,
      );
      expect(result.customerName).toBe('Дмитрий');
    });

    it('409 со списком мест, если констрейнт отбил вставку', async () => {
      // имитируем pg: уникальный констрейнт (session_id, seat)
      emInsert.mockRejectedValue({ code: '23505' });
      occupancyRepo.find.mockResolvedValue([
        { seat: '5-7', sessionId: 'session-1' },
        { seat: '5-8', sessionId: 'session-1' },
      ]);

      const promise = service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['5-8', '5-7', '6-1'],
        },
        authUser,
      );

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        seatsTaken: ['5-7', '5-8'],
      });
      // конфликт искали среди мест именно этого сеанса
      expect(occupancyRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sessionId: 'session-1' }),
        }),
      );
      // событие в очередь не ушло
      expect(rabbit.publish).not.toHaveBeenCalled();
    });
  });

  describe('sessionPrice', () => {
    it('витрина цены: факторы и dynamic=true, когда Тарификатор ответил', async () => {
      pricing.quote.mockResolvedValueOnce({
        priceRub: 550,
        basePriceRub: 400,
        factors: [
          { code: 'evening', label: 'вечерний прайм +20%', percent: 20 },
          { code: 'demand_high', label: 'спрос высокий +10%', percent: 10 },
        ],
        occupied: 45,
        capacity: 80,
      });

      const dto = await service.sessionPrice('session-1');

      expect(dto).toMatchObject({
        sessionId: 'session-1',
        sessionAt: sessionFixture.startsAt.toISOString(),
        basePriceRub: 400,
        priceRub: 550,
        dynamic: true,
      });
      expect(dto.factors).toHaveLength(2);
    });

    it('недоступность Тарификатора — dynamic=false и базовая цена', async () => {
      pricing.quote.mockRejectedValueOnce(new Error('unavailable'));

      const dto = await service.sessionPrice('session-1');

      expect(dto).toMatchObject({
        priceRub: 400,
        basePriceRub: 400,
        dynamic: false,
      });
      expect(dto.factors).toEqual([]);
    });
  });

  describe('pay', () => {
    beforeEach(() => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });
    });

    it('переводит PENDING_PAYMENT → PENDING условным UPDATE', async () => {
      const result = await service.pay('booking-1', authUser);

      expect(result.status).toBe('PENDING');
      expect(emUpdate).toHaveBeenCalledWith(
        Booking,
        { id: 'booking-1', status: 'PENDING_PAYMENT' },
        { status: 'PENDING' },
      );
    });

    it('публикует booking.created — воркер начинает проводить платёж', async () => {
      await service.pay('booking-1', authUser);

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.objectContaining({
          bookingId: 'booking-1',
          movieTitle: 'Рекурсия',
          sessionId: 'session-1',
          hall: 'IMAX',
          seats: ['5-7', '5-8', '5-9'],
          totalRub: 1200,
        }),
      );
      expect(stream.emit).toHaveBeenCalledTimes(1);
    });

    it('409 с текущим статусом, если бронь уже не ждёт оплаты', async () => {
      emUpdate.mockResolvedValue({ affected: 0 });

      const promise = service.pay('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({ status: 'PENDING_PAYMENT' });
      expect(rabbit.publish).not.toHaveBeenCalled();
    });

    it('403: чужую бронь оплатить нельзя', async () => {
      const promise = service.pay('booking-1', {
        ...authUser,
        id: 'user-2',
        name: 'Гость',
      });

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      expect(emUpdate).not.toHaveBeenCalled();
      expect(rabbit.publish).not.toHaveBeenCalled();
    });
  });

  describe('pay с промокодом', () => {
    beforeEach(() => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });
    });

    it('применяет промокод: скидка в totalRub, код и сумма — на брони', async () => {
      emQuery.mockResolvedValue([
        [{ code: 'CINE10', kind: 'percent', value: 10 }],
        1,
      ]);

      const result = await service.pay('booking-1', authUser, 'cine10');

      // 1200 − 10% = 1080
      expect(result).toMatchObject({
        status: 'PENDING',
        totalRub: 1080,
        promoCode: 'CINE10',
        discountRub: 120,
      });
      expect(emUpdate).toHaveBeenCalledTimes(2);
      expect(emUpdate).toHaveBeenLastCalledWith(
        Booking,
        { id: 'booking-1' },
        { totalRub: 1080, promoCode: 'CINE10', discountRub: 120 },
      );
    });

    it('воркеру уходит событие со скидочной суммой', async () => {
      emQuery.mockResolvedValue([
        [{ code: 'CINE10', kind: 'percent', value: 10 }],
        1,
      ]);

      await service.pay('booking-1', authUser, 'CINE10');

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.objectContaining({ totalRub: 1080 }),
      );
    });

    it('гонка за последний код: активация не прошла → 409 promoExhausted, оплата откатилась', async () => {
      emQuery.mockResolvedValue([[], 0]);
      promosRepo.findOneBy.mockResolvedValue({
        id: 'promo-1',
        code: 'CINE10',
        kind: 'percent',
        value: 10,
        maxActivations: 3,
        usedCount: 3,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const promise = service.pay('booking-1', authUser, 'CINE10');

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({ code: 'promoExhausted' });
      // скидка не писалась и событие воркеру не ушло — транзакция откатилась
      expect(emUpdate).toHaveBeenCalledTimes(1);
      expect(rabbit.publish).not.toHaveBeenCalled();
    });

    it('неизвестный код → 404 promoNotFound', async () => {
      emQuery.mockResolvedValue([[], 0]);
      promosRepo.findOneBy.mockResolvedValue(null);

      const promise = service.pay('booking-1', authUser, 'NOPE');

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      const err = (await promise.catch((e: unknown) => e)) as NotFoundException;
      expect(err.getResponse()).toMatchObject({ code: 'promoNotFound' });
    });

    it('просроченный код → 410 promoExpired', async () => {
      emQuery.mockResolvedValue([[], 0]);
      promosRepo.findOneBy.mockResolvedValue({
        id: 'promo-1',
        code: 'OLD10',
        kind: 'percent',
        value: 10,
        maxActivations: 100,
        usedCount: 0,
        expiresAt: new Date(Date.now() - 1000),
      });

      const promise = service.pay('booking-1', authUser, 'OLD10');

      await expect(promise).rejects.toBeInstanceOf(GoneException);
      const err = (await promise.catch((e: unknown) => e)) as GoneException;
      expect(err.getResponse()).toMatchObject({ code: 'promoExpired' });
    });

    describe('списание бонусов', () => {
      /** сидим на счёт 500 бонусов (кэшбэк прошлой брони) */
      const seedBalance = (amount = 500) => {
        bonusRows.push({
          userId: 'user-1',
          bookingId: 'seed-booking',
          kind: 'accrual',
          reason: 'cashback',
          amount,
        });
      };

      it('списывает бонусы в пределах лимита: spend-строка в ledger, итог меньше', async () => {
        seedBalance(500);

        const result = await service.pay('booking-1', authUser, undefined, 400);

        // 1200 − 400 бонусов = 800
        expect(result).toMatchObject({
          status: 'PENDING',
          totalRub: 800,
          bonusSpent: 400,
        });
        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'spend',
          reason: 'payment',
          amount: 400,
        });
        expect(emUpdate).toHaveBeenLastCalledWith(
          Booking,
          { id: 'booking-1' },
          { totalRub: 800, bonusSpent: 400 },
        );
        expect(rabbit.publish).toHaveBeenCalledWith(
          'cinema',
          'booking.created',
          expect.objectContaining({ totalRub: 800 }),
        );
      });

      it('промокод и бонусы вместе: скидка первой, лимит — от остатка', async () => {
        seedBalance(600);
        emQuery.mockImplementation(async (sql: string, params: unknown[]) => {
          if (/UPDATE promos/.test(sql)) {
            return [[{ code: 'CINE10', kind: 'percent', value: 10 }], 1];
          }
          if (/user_id/.test(sql)) {
            const balance = bonusRows
              .filter((r) => r.userId === params[0])
              .reduce(
                (s, r) => s + (r.kind === 'accrual' ? r.amount : -r.amount),
                0,
              );
            return [{ balance: String(balance) }];
          }
          return [[], 0];
        });

        // 1200 −10% = 1080; половина остатка = 540 — граница проходит
        const result = await service.pay(
          'booking-1',
          authUser,
          'CINE10',
          540,
        );

        expect(result).toMatchObject({
          totalRub: 540,
          discountRub: 120,
          bonusSpent: 540,
        });
      });

      it('409 bonusOverLimit: больше половины чека, оплата откатилась', async () => {
        seedBalance(5000);

        // лимит = 600, просим 700
        const promise = service.pay('booking-1', authUser, undefined, 700);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusOverLimit' });
        // только переключение статуса — скидки/списания не писались
        expect(emUpdate).toHaveBeenCalledTimes(1);
        expect(bonusRows).toHaveLength(1); // только сид
        expect(rabbit.publish).not.toHaveBeenCalled();
      });

      it('409 bonusInsufficient: баланса меньше запрошенного', async () => {
        seedBalance(100);

        const promise = service.pay('booking-1', authUser, undefined, 200);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusInsufficient' });
        expect(bonusRows).toHaveLength(1);
      });

      it('гонка балансом: контрольный пересчёт ушёл в минус → 409, всё откатилось', async () => {
        seedBalance(300);
        let balanceCalls = 0;
        emQuery.mockImplementation(async (sql: string) => {
          if (/user_id/.test(sql)) {
            balanceCalls += 1;
            // первая проверка видит 300; после вставки «параллельная оплата»
            // успела списать 500 — контрольный пересчёт уходит в минус
            return [{ balance: balanceCalls === 1 ? '300' : '-200' }];
          }
          return [[], 0];
        });

        const promise = service.pay('booking-1', authUser, undefined, 200);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusInsufficient' });
        expect(rabbit.publish).not.toHaveBeenCalled();
      });

      it('409 bonusUnavailable: гостевая бронь без владельца', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          userId: null,
          status: 'PENDING_PAYMENT',
        });

        const promise = service.pay('booking-1', authUser, undefined, 100);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusUnavailable' });
      });
    });
  });

  describe('list', () => {
    it('возвращает DTO с данными фильма и сеанса', async () => {
      bookingsRepo.find.mockResolvedValue([bookingFixture()]);

      const result = await service.list();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'booking-1',
        movieTitle: 'Рекурсия',
        movieHue: 275,
        movieGenreIcon: '🌀',
        sessionId: 'session-1',
        hall: 'IMAX',
        status: 'PENDING',
      });
    });
  });

  describe('my', () => {
    it('отбирает брони по владельцу из JWT и маппит в DTO', async () => {
      bookingsRepo.find.mockResolvedValue([bookingFixture()]);

      const result = await service.my(authUser);

      expect(bookingsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' } }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'booking-1', userId: 'user-1' });
    });

    it('у пользователя без броней — пустой список', async () => {
      bookingsRepo.find.mockResolvedValue([]);

      await expect(service.my(authUser)).resolves.toEqual([]);
    });
  });

  describe('tickets', () => {
    beforeEach(() => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CONFIRMED',
      });
    });

    it('по билету на каждое место: подпись hex-128 и номер TK-XXXXXX', async () => {
      const result = await service.tickets('booking-1', authUser);

      expect(result).toHaveLength(3); // места 5-7, 5-8, 5-9
      expect(result.map((t) => t.seat)).toEqual(['5-7', '5-8', '5-9']);
      for (const ticket of result) {
        expect(ticket.bookingId).toBe('booking-1');
        expect(ticket.signature).toMatch(/^[0-9a-f]{32}$/);
        expect(ticket.ticketNo).toMatch(/^TK-[0-9A-Z]{6}$/);
        expect(ticket.movieTitle).toBe('Рекурсия');
        expect(ticket.hall).toBe('IMAX');
        expect(ticket.customerName).toBe('Дмитрий');
      }
      // каждое место подписано отдельно
      const sigs = new Set(result.map((t) => t.signature));
      expect(sigs.size).toBe(3);
    });

    it('подпись детерминирована: повторная выдача — те же билеты', async () => {
      const first = await service.tickets('booking-1', authUser);
      const second = await service.tickets('booking-1', authUser);

      expect(second.map((t) => t.signature)).toEqual(
        first.map((t) => t.signature),
      );
      expect(second.map((t) => t.ticketNo)).toEqual(
        first.map((t) => t.ticketNo),
      );
    });

    it('403: чужие билеты не выдаются', async () => {
      const promise = service.tickets('booking-1', {
        ...authUser,
        id: 'user-2',
        name: 'Гость',
      });

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('409 bookingNotConfirmed: бронь ещё не подтверждена', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });

      const promise = service.tickets('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({
        code: 'bookingNotConfirmed',
        status: 'PENDING_PAYMENT',
      });
    });

    it('409 bookingNotConfirmed: отменённая бронь гасит билеты', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLED',
      });

      const promise = service.tickets('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({ code: 'bookingNotConfirmed' });
    });
  });

  describe('verifyTicket', () => {
    /** сеанс в будущем — критерий живого билета */
    const startsAt = new Date(Date.now() + 3_600_000);
    const canonicalOf = (seat: string) => ticketCanonical('booking-1', seat, startsAt);
    const qrOf = (seat: string) => `${canonicalOf(seat)}|${signTicket(canonicalOf(seat))}`;

    beforeEach(() => {
      bookingsRepo.findOneBy.mockResolvedValue({
        ...bookingFixture(),
        status: 'CONFIRMED',
      });
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt,
      });
    });

    it('валидный билет → true с контекстом для экрана контролёра', async () => {
      const verdict = await service.verifyTicket(qrOf('5-7'));

      expect(verdict).toMatchObject({
        valid: true,
        reason: null,
        bookingId: 'booking-1',
        seat: '5-7',
        movieTitle: 'Рекурсия',
        hall: 'IMAX',
        customerName: 'Дмитрий',
      });
    });

    it('подделка подписи → false, badSignature', async () => {
      const payload = `${canonicalOf('5-7')}|${'0'.repeat(32)}`;

      const verdict = await service.verifyTicket(payload);

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'badSignature',
        seat: '5-7',
      });
      // подделку отсеивает подпись — до БД дело не доходит
      expect(bookingsRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('мусорная строка → false, malformedPayload', async () => {
      const verdict = await service.verifyTicket('не QR-строка');

      expect(verdict).toMatchObject({ valid: false, reason: 'malformedPayload' });
      expect(bookingsRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('бронь не найдена → false, bookingNotFound', async () => {
      bookingsRepo.findOneBy.mockResolvedValue(null);

      const verdict = await service.verifyTicket(qrOf('5-7'));

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'bookingNotFound',
        bookingId: 'booking-1',
      });
    });

    it('бронь не подтверждена → false, bookingNotConfirmed', async () => {
      bookingsRepo.findOneBy.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLED',
      });

      const verdict = await service.verifyTicket(qrOf('5-7'));

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'bookingNotConfirmed',
      });
    });

    it('чужое место (подпись честная) → false, seatMismatch', async () => {
      // место существует в зале, но брони не принадлежит; подпись
      // посчитана правильно — отсеивает именно состав мест брони
      const verdict = await service.verifyTicket(qrOf('8-10'));

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'seatMismatch',
        seat: '8-10',
      });
    });

    it('сеанс уже прошёл → false, sessionPassed', async () => {
      const past = new Date(Date.now() - 3_600_000);
      const canonical = ticketCanonical('booking-1', '5-7', past);
      const payload = `${canonical}|${signTicket(canonical)}`;
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt: past,
      });

      const verdict = await service.verifyTicket(payload);

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'sessionPassed',
        movieTitle: 'Рекурсия',
      });
    });
  });

  describe('cancel', () => {
    /** «строка БД»: условный UPDATE по статусу — как WHERE в реальном PG */
    let db: Booking;

    beforeEach(() => {
      db = { ...bookingFixture(), status: 'CONFIRMED' };
      bookingsRepo.findOneByOrFail.mockResolvedValue(db);
      bookingsRepo.update.mockImplementation(
        async (criteria: { status?: BookingStatus }, patch: Partial<Booking>) => {
          if (criteria.status && db.status !== criteria.status) {
            return { affected: 0 };
          }
          Object.assign(db, patch);
          return { affected: 1 };
        },
      );
    });

    it('переводит CONFIRMED-бронь в CANCELLING', async () => {
      const result = await service.cancel('booking-1', authUser);

      expect(result.status).toBe('CANCELLING');
      expect(bookingsRepo.update).toHaveBeenCalledWith(
        { id: 'booking-1', status: 'CONFIRMED' },
        { status: 'CANCELLING' },
      );
    });

    it('публикует booking.cancelled с суммой возврата и сеансом', async () => {
      await service.cancel('booking-1', authUser);

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'booking.cancelled',
        expect.objectContaining({
          bookingId: 'booking-1',
          movieTitle: 'Рекурсия',
          sessionId: 'session-1',
          hall: 'IMAX',
          seats: ['5-7', '5-8', '5-9'],
          totalRub: 1200,
        }),
      );
    });

    it('403: чужую бронь отменить нельзя', async () => {
      const promise = service.cancel('booking-1', {
        ...authUser,
        id: 'user-2',
        name: 'Гость',
      });

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      // сага не запускается — события и UPDATE не было
      expect(rabbit.publish).not.toHaveBeenCalled();
      expect(bookingsRepo.update).not.toHaveBeenCalled();
    });

    it('409 с текущим статусом, если статус не отменяемый', async () => {
      db.status = 'PENDING'; // платёж уже в полёте

      const promise = service.cancel('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ status: 'PENDING' });
      // сага не запущена — события нет
      expect(rabbit.publish).not.toHaveBeenCalled();
    });

    it('неоплаченную (PENDING_PAYMENT) закрывает сразу, без воркера', async () => {
      db.status = 'PENDING_PAYMENT';

      const result = await service.cancel('booking-1', authUser);

      expect(result.status).toBe('CANCELLED');
      expect(bookingsRepo.update).toHaveBeenCalledWith(
        { id: 'booking-1', status: 'PENDING_PAYMENT' },
        expect.objectContaining({ status: 'CANCELLED' }),
      );
      // возвращать нечего — события booking.cancelled нет; но места
      // освободились — лист ожидания должен об этом узнать
      expect(rabbit.publish).toHaveBeenCalledTimes(1);
      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'waitlist.seat.released',
        expect.objectContaining({
          sessionId: 'session-1',
          bookingId: 'booking-1',
          reason: 'CANCELLED_UNPAID',
        }),
      );
    });

    it('отмена неоплаченной освобождает места сразу', async () => {
      db.status = 'PENDING_PAYMENT';

      await service.cancel('booking-1', authUser);

      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
    });
  });

  describe('stats', () => {
    it('считает брони по статусам, заполняя нули', async () => {
      bookingsRepo.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { status: 'CONFIRMED', count: '2' },
          { status: 'PENDING', count: '1' },
          { status: 'CANCELLED', count: '3' },
        ]),
      });

      const result = await service.stats();

      expect(result).toEqual({
        PENDING_PAYMENT: 0,
        PENDING: 1,
        CONFIRMED: 2,
        FAILED: 0,
        EXPIRED: 0,
        CANCELLING: 0,
        CANCELLED: 3,
      });
    });
  });

  describe('handleProcessed', () => {
    it('применяет вердикт воркера и сохраняет', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(bookingsRepo.save).toHaveBeenCalledTimes(1);
      const saved = bookingsRepo.save.mock.calls[0][0] as Booking;
      expect(saved.status).toBe('CONFIRMED');
      expect(saved.message).toBe('Оплата прошла');
      expect(saved.processedBy).toBe('go-worker-1');
      expect(saved.processedAt).toEqual(new Date('2026-09-03T12:00:05Z'));
      // подтверждённая бронь держит места
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
    });

    it('FAILED — освобождает места брони', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'FAILED',
        message: 'Платёж отклонён',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
    });

    it('CONFIRMED публикует сигнал КиноСоветнику (dedup по bookingId)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'recommendation.booking.confirmed',
        {
          userId: 'user-1',
          movieId: 'movie-1',
          movieTitle: 'Рекурсия',
          genre: 'хоррор',
          bookingId: 'booking-1',
          occurredAt: expect.any(String),
        },
      );
    });

    it('гостевая CONFIRMED-бронь сигнал рекомендациям не публикует', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        userId: null,
      });

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(rabbit.publish).not.toHaveBeenCalledWith(
        'cinema',
        'recommendation.booking.confirmed',
        expect.anything(),
      );
    });

    it('CONFIRMED с будущим сеансом планирует напоминание (email владельца)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
      // фикстурный сеанс давно прошёл — подменяем будущим
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
      });

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });
      await flushAsync();

      expect(reminders.schedule).toHaveBeenCalledWith({
        bookingId: 'booking-1',
        userId: 'user-1',
        email: 'dmitry@example.com',
        movieId: 'movie-1',
        movieTitle: 'Рекурсия',
        hall: 'IMAX',
        sessionAt: expect.any(String),
        seats: ['5-7', '5-8', '5-9'],
      });
    });

    it('сеанс уже прошёл — напоминание не планируется', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
      // фикстура: startsAt 2026-09-05 — в прошлом

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });
      await flushAsync();

      expect(reminders.schedule).not.toHaveBeenCalled();
    });

    it('недоступность reminder-сервиса не валит вердикт', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
      });
      reminders.schedule.mockRejectedValueOnce(new Error('UNAVAILABLE'));

      await expect(
        service.handleProcessed({
          bookingId: 'booking-1',
          status: 'CONFIRMED',
          message: 'Оплата прошла',
          processedBy: 'go-worker-1',
          processedAt: '2026-09-03T12:00:05Z',
        }),
      ).resolves.toBeUndefined();
      await flushAsync();

      expect(bookingsRepo.save).toHaveBeenCalledTimes(1);
    });

    it('пропускает вердикт по бронь не в PENDING (ределивери/EXPIRED)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'EXPIRED',
      });

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(bookingsRepo.save).not.toHaveBeenCalled();
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
      expect(stream.emit).not.toHaveBeenCalled();
    });

    describe('бонусный хвост вердикта', () => {
      const processed = (status: 'CONFIRMED' | 'FAILED') => ({
        bookingId: 'booking-1',
        status,
        message: status === 'CONFIRMED' ? 'Оплата прошла' : 'Платёж отклонён',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      it('CONFIRMED начисляет кэшбэк: 5% от финальной суммы, floor', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          totalRub: 1080,
        });

        await service.handleProcessed(processed('CONFIRMED'));

        // floor(1080 × 5%) = 54 — от суммы после промокода и бонусов
        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'cashback',
          amount: 54,
        });
      });

      it('копеечная оплата — кэшбэк ноль, строки нет', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          totalRub: 19, // floor(0.95) = 0
        });

        await service.handleProcessed(processed('CONFIRMED'));

        expect(bonusRows).toHaveLength(0);
      });

      it('FAILED возвращает списанные при оплате бонусы', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          bonusSpent: 400,
        });

        await service.handleProcessed(processed('FAILED'));

        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'payment_failed',
          amount: 400,
        });
      });

      it('FAILED без списания — строки нет', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

        await service.handleProcessed(processed('FAILED'));

        expect(bonusRows).toHaveLength(0);
      });

      it('гостевая бронь (без владельца) кэшбэк не зарабатывает', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          userId: null,
        });

        await service.handleProcessed(processed('CONFIRMED'));

        expect(bonusRows).toHaveLength(0);
      });
    });
  });

  describe('handleExpired', () => {
    it('гасит ждущую оплаты бронь в EXPIRED и освобождает места', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'EXPIRED',
      });

      await service.handleExpired({
        bookingId: 'booking-1',
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: '2026-09-03T12:15:00Z',
      });

      expect(bookingsRepo.update).toHaveBeenCalledWith(
        { id: 'booking-1', status: 'PENDING_PAYMENT' },
        {
          status: 'EXPIRED',
          message: 'Время оплаты истекло',
          processedBy: 'go-worker-1',
          processedAt: new Date('2026-09-03T12:15:00Z'),
        },
      );
      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
      expect(stream.emit).toHaveBeenCalledTimes(1);
    });

    it('пропускает событие, если бронь уже не ждёт оплаты (pay-vs-timeout)', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 0 });

      await service.handleExpired({
        bookingId: 'booking-1',
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: '2026-09-03T12:15:00Z',
      });

      expect(occupancyRepo.delete).not.toHaveBeenCalled();
      expect(stream.emit).not.toHaveBeenCalled();
    });
  });

  describe('handleRefunded', () => {
    function cancellingFixture(): Booking {
      return { ...bookingFixture(), status: 'CANCELLING' };
    }

    it('CANCELLED — закрывает сагу и освобождает места', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      const saved = bookingsRepo.save.mock.calls[0][0] as Booking;
      expect(saved.status).toBe('CANCELLED');
      expect(saved.message).toBe('Возврат 1200 ₽ зачислен');
      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
    });

    it('CANCELLED — гасит напоминание брони', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });
      await flushAsync();

      expect(reminders.cancel).toHaveBeenCalledWith('booking-1');
    });

    it('REFUND_FAILED — напоминание продолжает ждать сеанса', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'REFUND_FAILED',
        message: 'Банк отклонил возврат',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });
      await flushAsync();

      expect(reminders.cancel).not.toHaveBeenCalled();
    });

    it('REFUND_FAILED — откатывает в CONFIRMED, места держит', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'REFUND_FAILED',
        message: 'Банк отклонил возврат',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      const saved = bookingsRepo.save.mock.calls[0][0] as Booking;
      expect(saved.status).toBe('CONFIRMED');
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
    });

    it('пропускает событие по бронь не в CANCELLING (ределивери)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      expect(bookingsRepo.save).not.toHaveBeenCalled();
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
    });

    describe('разворот бонусов', () => {
      const refunded = (status: 'CANCELLED' | 'REFUND_FAILED') => ({
        bookingId: 'booking-1',
        status,
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      it('CANCELLED: списанное вернулось, кэшбэк погасился', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());
        // бронь оплачена с 400 бонусами, кэшбэк по ней — 54
        bonusRows.push(
          {
            userId: 'user-1',
            bookingId: 'booking-1',
            kind: 'spend',
            reason: 'payment',
            amount: 400,
          },
          {
            userId: 'user-1',
            bookingId: 'booking-1',
            kind: 'accrual',
            reason: 'cashback',
            amount: 54,
          },
        );

        await service.handleRefunded(refunded('CANCELLED'));

        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'refund',
          amount: 400,
        });
        // баланс к моменту гашения: −400 + 54 + 400 = 54 → весь кэшбэк
        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'spend',
          reason: 'clawback',
          amount: 54,
        });
      });

      it('кэшбэк уже потрачен — гасим сколько есть, не в минус', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());
        // кэшбэк 100 по этой брони, 60 из него потрачено на другой —
        // баланс 40, гасим только его
        bonusRows.push(
          {
            userId: 'user-1',
            bookingId: 'booking-1',
            kind: 'accrual',
            reason: 'cashback',
            amount: 100,
          },
          {
            userId: 'user-1',
            bookingId: 'other-booking',
            kind: 'spend',
            reason: 'payment',
            amount: 60,
          },
        );

        await service.handleRefunded(refunded('CANCELLED'));

        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'spend',
          reason: 'clawback',
          amount: 40,
        });
        // списания при оплате этой брони не было — refund-строки нет
        expect(
          bonusRows.filter((r) => r.reason === 'refund'),
        ).toHaveLength(0);
      });

      it('REFUND_FAILED — бронь живёт дальше, бонусы не тронуты', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());
        bonusRows.push({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'cashback',
          amount: 54,
        });

        await service.handleRefunded(refunded('REFUND_FAILED'));

        expect(bonusRows).toHaveLength(1);
      });
    });
  });

  describe('SSE: уведомление подключённых клиентов', () => {
    it('create → событие с новой бронью и статистикой', async () => {
      await service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['1-1'],
        },
        authUser,
      );

      expect(stream.emit).toHaveBeenCalledTimes(1);
      const payload = stream.emit.mock.calls[0][0];
      expect(payload.booking).toMatchObject({
        movieId: 'movie-1',
        sessionId: 'session-1',
        hall: 'IMAX',
        status: 'PENDING_PAYMENT',
        movieTitle: 'Рекурсия',
      });
      expect(payload.stats).toEqual({
        PENDING_PAYMENT: 0,
        PENDING: 0,
        CONFIRMED: 0,
        FAILED: 0,
        EXPIRED: 0,
        CANCELLING: 0,
        CANCELLED: 0,
      });
    });

    it('handleProcessed → событие с вердиктом воркера', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(stream.emit).toHaveBeenCalledTimes(1);
      const payload = stream.emit.mock.calls[0][0];
      expect(payload.booking.status).toBe('CONFIRMED');
    });

    it('пропущенный ределивери → без события', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      expect(stream.emit).not.toHaveBeenCalled();
    });
  });

  describe('живая карта: сигнал SeatStream', () => {
    it('create (места заняты) → сигнал по сеансу', async () => {
      await service.create(
        { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['1-1'] },
        authUser,
      );

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('конфликт мест → без сигнала (транзакция откатилась)', async () => {
      emInsert.mockRejectedValue({ code: '23505' });

      await expect(
        service.create(
          { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['1-1'] },
          authUser,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(seatStream.emit).not.toHaveBeenCalled();
    });

    it('отмена неоплаченной → сигнал (места свободны)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });

      await service.cancel('booking-1', authUser);

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('FAILED-вердикт воркера → сигнал', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'FAILED',
        message: 'Банк отказал',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('EXPIRED по TTL → сигнал', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'EXPIRED',
      });

      await service.handleExpired({
        bookingId: 'booking-1',
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: '2026-09-03T12:15:00Z',
      });

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('возврат по саге (CANCELLED) → сигнал', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLING',
      });

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('REFUND_FAILED (места держатся) и ределивери EXPIRED → без сигнала', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLING',
      });

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'REFUND_FAILED',
        message: 'Банк отказал в возврате',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });
      expect(seatStream.emit).not.toHaveBeenCalled();

      bookingsRepo.update.mockResolvedValue({ affected: 0 });
      await service.handleExpired({
        bookingId: 'booking-1',
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: '2026-09-03T12:15:00Z',
      });
      expect(seatStream.emit).not.toHaveBeenCalled();
    });
  });

  describe('seatMap', () => {
    it('отдаёт занятые места сеанса, геометрию зала и счётчик свободных', async () => {
      occupancyRepo.find.mockResolvedValue([
        { seat: '5-7' },
        { seat: '1-1' },
      ]);

      const map = await service.seatMap('session-1');

      expect(sessionsRepo.findOneByOrFail).toHaveBeenCalledWith({
        id: 'session-1',
      });
      expect(map.sessionId).toBe('session-1');
      expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
      expect(map.occupied).toEqual(['1-1', '5-7']); // сортировка по залу
      expect(map.free).toBe(80 - 2);
    });
  });
});

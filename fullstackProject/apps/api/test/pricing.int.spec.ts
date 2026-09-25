import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { DataSource } from 'typeorm';
import { Booking } from '../src/bookings/booking.entity';
import { BookingStream } from '../src/bookings/booking-stream';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingsService } from '../src/bookings/bookings.service';
import { SessionPriceController } from '../src/bookings/session-price.controller';
import { SeatStream } from '../src/bookings/seat-stream';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { BonusTransaction } from '../src/bonus/bonus-transaction.entity';
import { Movie } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { Promo } from '../src/promos/promo.entity';
import { PricingClient } from '../src/pricing/pricing.client';
import { RemindersClient } from '../src/reminders/reminders.client';
import { User } from '../src/users/user.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';

/**
 * Интеграция Тарификатора: create() спрашивает цену по gRPC (фейк) и
 * кладёт её в чек; витрина GET /sessions/:id/price отвечает раскладкой
 * факторов и честной деградацией на базовую цену.
 */

/** seанс-uuid: контроллер цены валидирует Param ParseUUIDPipe */
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

const futureSession: Session = {
  id: '11111111-1111-4111-8111-111111111111',
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

const authUser = { id: 'user-1', email: 'd@cine.local', name: 'Дмитрий', role: 'user' as const };

describe('Pricing (integration)', () => {
  let app: INestApplication;
  let service: BookingsService;
  let pricing: { quote: jest.Mock };

  beforeAll(async () => {
    const bookingsRepo = {
      // merge с таймстампами — как настоящий репозиторий (createdAt в DTO)
      save: jest.fn(async (x: Partial<Booking>) => ({
        ...x,
        createdAt: x.createdAt ?? new Date(),
        updatedAt: new Date(),
      })),
      findOneByOrFail: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };
    const em = {
      findOneByOrFail: (entity: unknown, where: { id: string }) =>
        entity === Session
          ? Promise.resolve(futureSession)
          : Promise.resolve(movieFixture),
      save: (_entity: unknown, x: Booking) => bookingsRepo.save(x),
      create: (_entity: unknown, x: Partial<Booking>) => x,
      insert: jest.fn(async () => undefined),
      update: jest.fn(async () => ({ affected: 1 })),
      query: jest.fn(async () => [[], 0]),
      createQueryBuilder: () => ({
        insert: () => ({
          into: (entity: unknown) => {
            if (entity !== BonusTransaction) {
              throw new Error(`Неожиданный insert-QB в тесте: ${String(entity)}`);
            }
            return {
              values: () => ({ orIgnore: () => ({ execute: async () => undefined }) }),
            };
          },
        }),
      }),
    };

    pricing = {
      quote: jest.fn(async () => ({
        priceRub: 400,
        basePriceRub: 400,
        factors: [],
        occupied: 0,
        capacity: 80,
      })),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BookingsController, SessionPriceController],
      providers: [
        BookingsService,
        BookingStream,
        SeatStream,
        { provide: PricingClient, useValue: pricing },
        { provide: RemindersClient, useValue: { schedule: jest.fn(), cancel: jest.fn() } },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: getRepositoryToken(Movie), useValue: { findOneByOrFail: jest.fn(async () => movieFixture) } },
        { provide: getRepositoryToken(Session), useValue: { findOneByOrFail: jest.fn(async () => futureSession) } },
        { provide: getRepositoryToken(SeatOccupancy), useValue: { find: jest.fn(async () => []), delete: jest.fn() } },
        { provide: getRepositoryToken(Promo), useValue: { findOneBy: jest.fn(async () => null) } },
        { provide: getRepositoryToken(WaitlistEntry), useValue: { update: jest.fn(async () => ({ affected: 0 })) } },
        { provide: getRepositoryToken(User), useValue: { findOneByOrFail: jest.fn() } },
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('create: квот Тарификатора ложится в чек брони', async () => {
    pricing.quote.mockResolvedValueOnce({
      priceRub: 430, // вечер × пустой зал
      basePriceRub: 400,
      factors: [
        { code: 'evening', label: 'вечерний прайм +20%', percent: 20 },
        { code: 'demand_low', label: 'зал почти пуст −10%', percent: -10 },
      ],
      occupied: 4,
      capacity: 80,
    });

    const booking = await service.create(
      { sessionId: SESSION_ID, seats: ['5-7', '5-8'] },
      authUser,
    );

    expect(booking.totalRub).toBe(860); // 430 × 2
    expect(pricing.quote).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, capacity: 80 }),
    );
  });

  it('GET /api/sessions/:id/price — раскладка факторов', async () => {
    await app.listen(0);
    const { port } = app.getHttpServer().address() as { port: number };
    pricing.quote.mockResolvedValueOnce({
      priceRub: 600,
      basePriceRub: 400,
      factors: [{ code: 'demand_full', label: 'аншлаг +25%', percent: 25 }],
      occupied: 70,
      capacity: 80,
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${SESSION_ID}/price`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      priceRub: number;
      basePriceRub: number;
      dynamic: boolean;
      factors: { code: string }[];
    };
    expect(body).toMatchObject({ priceRub: 600, basePriceRub: 400, dynamic: true });
    expect(body.factors).toEqual([{ code: 'demand_full', label: 'аншлаг +25%', percent: 25 }]);
    await app.close();
  });

  it('GET /api/sessions/:id/price — деградация на базовую при отказе', async () => {
    await app.listen(0);
    const { port } = app.getHttpServer().address() as { port: number };
    pricing.quote.mockRejectedValueOnce(new Error('unavailable'));

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${SESSION_ID}/price`);
    expect(res.status).toBe(200); // деградация, а не ошибка запроса
    const body = (await res.json()) as { priceRub: number; dynamic: boolean };
    expect(body).toMatchObject({ priceRub: 400, dynamic: false });
    await app.close();
  });
});

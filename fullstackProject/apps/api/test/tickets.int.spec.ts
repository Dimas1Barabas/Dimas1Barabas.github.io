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
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingsService } from '../src/bookings/bookings.service';
import {
  signTicket,
  ticketCanonical,
} from '../src/bookings/ticket.logic';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { Movie } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { Promo } from '../src/promos/promo.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';

/**
 * Интеграционный тест QR-билетов: реальный HTTP-стек Nest (роутинг,
 * ValidationPipe, JWT/roles-гварды) на in-memory фейках Postgres.
 * Билеты — производная брони, поэтому вся кухня сводится к статусу
 * строки брони и честной подписи: фейк отдаёт то, что лежит в «БД».
 */

class FakeBookingRepo {
  rows: Booking[] = [];

  async findOneBy(where: { id: string }): Promise<Booking | null> {
    return this.rows.find((r) => r.id === where.id) ?? null;
  }

  async findOneByOrFail(where: { id: string }): Promise<Booking> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Бронь не найдена');
    return found;
  }
}

describe('QR-билеты: HTTP-интеграция (фейковые зависимости)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  /** будущая и прошедшая сессии — критерий «сеанс уже прошёл» */
  const futureSession: Session = {
    id: randomUUID(),
    movieId: randomUUID(),
    hall: 'IMAX',
    startsAt: new Date(Date.now() + 7 * 86_400_000),
  } as Session;
  const pastSession: Session = {
    ...futureSession,
    id: randomUUID(),
    startsAt: new Date(Date.now() - 86_400_000),
  } as Session;

  const movie: Movie = {
    id: randomUUID(),
    title: 'Рекурсия',
    hue: 275,
    genreIcon: '🌀',
  } as Movie;

  let app: INestApplication;
  let bookingsRepo: FakeBookingRepo;

  /** Authorization: владелец брони, «чужак» и администратор */
  let bearer: string;
  let bearerB: string;
  let bearerAdmin: string;

  /** бронь «владельца» (user-a); по умолчанию подтверждена, 2 места */
  const seedBooking = (overrides: Partial<Booking> = {}): Booking => {
    const row: Booking = {
      id: randomUUID(),
      movieId: movie.id,
      movie: {} as Booking['movie'],
      sessionId: futureSession.id,
      session: {} as Booking['session'],
      customerName: 'Анна Тест',
      userId: 'user-a',
      seats: ['5-7', '5-8'],
      totalRub: 800,
      promoCode: null,
      discountRub: null,
      status: 'CONFIRMED',
      expiresAt: null,
      message: 'Оплата прошла',
      processedBy: 'go-worker-1',
      processedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    bookingsRepo.rows.push(row);
    return row;
  };

  /** QR-строка билета, подписанная дефолтным (dev) секретом API */
  const qrOf = (booking: Booking, seat: string, session: Session = futureSession) =>
    `${ticketCanonical(booking.id, seat, session.startsAt)}|${signTicket(
      ticketCanonical(booking.id, seat, session.startsAt),
    )}`;

  beforeAll(async () => {
    bookingsRepo = new FakeBookingRepo();

    const moviesRepo = {
      findOneByOrFail: jest.fn(async (_where: { id: string }) => movie),
    };
    const sessionsRepo = {
      findOneByOrFail: jest.fn(async (where: { id: string }) =>
        where.id === pastSession.id ? pastSession : futureSession,
      ),
    };
    const occupancyRepo = { insert: jest.fn(), delete: jest.fn(), find: jest.fn(async () => []) };
    const promosRepo = { findOneBy: jest.fn(async () => null) };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [BookingsController],
      providers: [
        BookingsService,
        BookingStream,
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(Session), useValue: sessionsRepo },
        { provide: getRepositoryToken(SeatOccupancy), useValue: occupancyRepo },
        { provide: getRepositoryToken(Promo), useValue: promosRepo },
        // create() гасит запись листа ожидания — фейку достаточно update
        { provide: getRepositoryToken(WaitlistEntry), useValue: { update: jest.fn(async () => ({ affected: 0 })) } },
        { provide: AmqpConnection, useValue: { connected: true, publish: jest.fn() } },
        { provide: DataSource, useValue: { query: jest.fn(async () => [[], 0]) } },
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

  describe('GET /api/bookings/:id/tickets', () => {
    it('401 без токена', async () => {
      const booking = seedBooking();
      const res = await request(app.getHttpServer()).get(
        `/api/bookings/${booking.id}/tickets`,
      );
      expect(res.status).toBe(401);
    });

    it('200: по билету на место, подпись детерминирована', async () => {
      const booking = seedBooking();

      const first = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}/tickets`)
        .set('Authorization', bearer);
      const second = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}/tickets`)
        .set('Authorization', bearer);

      expect(first.status).toBe(200);
      expect(first.body).toHaveLength(2);
      expect(first.body.map((t: { seat: string }) => t.seat)).toEqual(['5-7', '5-8']);
      for (const ticket of first.body) {
        expect(ticket.signature).toMatch(/^[0-9a-f]{32}$/);
        expect(ticket.ticketNo).toMatch(/^TK-[0-9A-Z]{6}$/);
        expect(ticket).toMatchObject({
          bookingId: booking.id,
          movieTitle: 'Рекурсия',
          hall: 'IMAX',
          customerName: 'Анна Тест',
        });
      }
      // производная без состояния: те же подписи на повторный запрос
      expect(second.body).toEqual(first.body);
    });

    it('403: чужому владельцу билеты не выдаются', async () => {
      const booking = seedBooking();
      const res = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}/tickets`)
        .set('Authorization', bearerB);
      expect(res.status).toBe(403);
    });

    it('409 bookingNotConfirmed: бронь ещё ждёт оплаты', async () => {
      const booking = seedBooking({ status: 'PENDING_PAYMENT' });
      const res = await request(app.getHttpServer())
        .get(`/api/bookings/${booking.id}/tickets`)
        .set('Authorization', bearer);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('bookingNotConfirmed');
      expect(res.body.status).toBe('PENDING_PAYMENT');
    });

    it('404: бронь не найдена', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/bookings/${randomUUID()}/tickets`)
        .set('Authorization', bearer);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/bookings/tickets/verify (сканер)', () => {
    it('401 без токена и 403 обычному пользователю', async () => {
      const booking = seedBooking();
      const payload = qrOf(booking, '5-7');

      const noAuth = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .send({ payload });
      const asUser = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearer)
        .send({ payload });

      expect(noAuth.status).toBe(401);
      expect(asUser.status).toBe(403);
    });

    it('400: строка совсем не похожа на QR (без разделителей)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload: 'мусор' });
      expect(res.status).toBe(400);
    });

    it('200 valid: валидный билет → контекст для экрана контролёра', async () => {
      const booking = seedBooking();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload: qrOf(booking, '5-7') });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        valid: true,
        reason: null,
        bookingId: booking.id,
        seat: '5-7',
        movieTitle: 'Рекурсия',
        hall: 'IMAX',
        customerName: 'Анна Тест',
      });
    });

    it('200 badSignature: перевёрнутая подпись — подделка', async () => {
      const booking = seedBooking();
      // каноническую часть не трогаем, переворачиваем хвост-подпись
      const honest = qrOf(booking, '5-7');
      const payload =
        honest.slice(0, -32) + honest.slice(-32).split('').reverse().join('');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        valid: false,
        reason: 'badSignature',
        seat: '5-7',
      });
    });

    it('200 malformedPayload: пять частей, но формат чужой', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload: 'CINE1|какая-то|чушь|в|полях' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ valid: false, reason: 'malformedPayload' });
    });

    it('200 bookingNotFound: подпись честная, брони нет', async () => {
      const ghost = randomUUID();
      const canonical = ticketCanonical(ghost, '5-7', futureSession.startsAt);
      const payload = `${canonical}|${signTicket(canonical)}`;

      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        valid: false,
        reason: 'bookingNotFound',
        bookingId: ghost,
      });
    });

    it('200 bookingNotConfirmed: отменённая бронь гасит билеты', async () => {
      const booking = seedBooking({ status: 'CANCELLED' });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload: qrOf(booking, '5-7') });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        valid: false,
        reason: 'bookingNotConfirmed',
      });
    });

    it('200 seatMismatch: место чужое, подпись честная', async () => {
      const booking = seedBooking();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload: qrOf(booking, '8-10') });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        valid: false,
        reason: 'seatMismatch',
        seat: '8-10',
      });
    });

    it('200 sessionPassed: сеанс уже прошёл', async () => {
      const booking = seedBooking({ sessionId: pastSession.id });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/tickets/verify')
        .set('Authorization', bearerAdmin)
        .send({ payload: qrOf(booking, '5-7', pastSession) });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        valid: false,
        reason: 'sessionPassed',
        movieTitle: 'Рекурсия',
      });
    });
  });
});

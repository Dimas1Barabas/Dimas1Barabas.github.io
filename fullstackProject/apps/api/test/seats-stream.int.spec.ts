import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import WebSocket from 'ws';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { Booking } from '../src/bookings/booking.entity';
import { BookingStream } from '../src/bookings/booking-stream';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingsService } from '../src/bookings/bookings.service';
import { SeatMapGateway } from '../src/bookings/seat-map.gateway';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { SeatStream } from '../src/bookings/seat-stream';
import { Movie } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { Promo } from '../src/promos/promo.entity';
import { PricingClient } from '../src/pricing/pricing.client';
import { RemindersClient } from '../src/reminders/reminders.client';
import { User } from '../src/users/user.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Интеграционный тест ws-гейтвея живой карты мест: реальный HTTP-стек Nest
 * с WsAdapter и живым сокет-сервером (app.listen(0)), клиент — настоящий ws.
 * Зависимости БД/брокера — in-memory фейки (как в http.int.spec.ts);
 * «транзакция» выполняет callback с эмуляцией EntityManager.
 */

type MovieWithSessionSeeds = Partial<Movie> & {
  sessions?: { hall: string; startsAt: Date }[];
};

class FakeMovieRepo {
  rows: Movie[] = [];

  async find(): Promise<Movie[]> {
    return [...this.rows];
  }

  create(x: MovieWithSessionSeeds): Movie {
    return x as Movie;
  }

  /** save эмулирует cascade: сеансы фильма становятся строками Session */
  async save(entities: unknown): Promise<unknown> {
    const list = (Array.isArray(entities) ? entities : [entities]) as Movie[];
    for (const e of list) {
      if (!e.id) e.id = randomUUID();
      if (!e.createdAt) e.createdAt = new Date();
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
    if (!this.rows.includes(booking)) this.rows.unshift(booking);
    return booking;
  }

  async findOneByOrFail(where: { id: string }): Promise<Booking> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Бронь не найдена');
    return found;
  }

  /** GROUP BY по статусам для SSE-статистики */
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

  /** условный UPDATE … WHERE id AND status (отмена неоплаченной) */
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
}

class FakeOccupancyRepo {
  rows: SeatOccupancy[] = [];

  async find(opts?: { where?: { sessionId?: string } }): Promise<SeatOccupancy[]> {
    const sessionId = opts?.where?.sessionId;
    return sessionId
      ? this.rows.filter((r) => r.sessionId === sessionId)
      : [...this.rows];
  }

  async delete(criteria: { bookingId?: string }): Promise<{ affected: number }> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(criteria.bookingId && r.bookingId === criteria.bookingId));
    return { affected: before - this.rows.length };
  }

  /** INSERT: дубль (sessionId, seat) падает кодом 23505 — как uq-констрейнт */
  insert(
    rows: { sessionId: string; seat: string; bookingId: string }[],
  ): Promise<void> {
    for (const r of rows) {
      if (this.rows.some((x) => x.sessionId === r.sessionId && x.seat === r.seat)) {
        return Promise.reject(Object.assign(new Error('dup'), { code: '23505' }));
      }
    }
    this.rows.push(
      ...rows.map((r) => ({ id: randomUUID(), createdAt: new Date(), ...r })),
    );
    return Promise.resolve();
  }
}

/** кадр живой карты (см. SeatFrame в гейтвее) */
type Frame =
  | { type: 'snapshot'; data: { sessionId: string; occupied: string[]; free: number } }
  | { type: 'error'; message: string };

describe('WS живая карта мест: HTTP+socket-интеграция (фейковые зависимости)', () => {
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let httpBase: string;
  let wsUrl: string;
  let occupancyRepo: FakeOccupancyRepo;
  let bearer: string;
  let sessionId: string;
  let otherSessionId: string;

  /** подключиться и дождаться open */
  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  /** следующий кадр с таймаутом (шина асинхронна — ждать, а не угадывать) */
  function nextFrame(socket: WebSocket, timeoutMs = 5000): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('кадр не пришёл за отведённое время')),
        timeoutMs,
      );
      socket.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as Frame);
      });
    });
  }

  function subscribe(socket: WebSocket, sid: string): void {
    socket.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
  }

  /** если кадр придёт — promise зарезолвится; для «тишины» ждём отведённое */
  function frameIfAny(socket: WebSocket, withinMs: number): Promise<Frame | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), withinMs);
      socket.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as Frame);
      });
    });
  }

  beforeAll(async () => {
    const moviesRepo = new FakeMovieRepo();
    const sessionsRepo = new FakeSessionRepo();
    const bookingsRepo = new FakeBookingRepo();
    occupancyRepo = new FakeOccupancyRepo();

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
      update: jest.fn(),
      query: jest.fn(async () => [[], 0]),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [BookingsController],
      providers: [
        BookingsService,
        BookingStream,
        SeatStream,
        SeatMapGateway,
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(Session), useValue: sessionsRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: getRepositoryToken(SeatOccupancy), useValue: occupancyRepo },
        { provide: getRepositoryToken(Promo), useValue: { findOneBy: jest.fn(async () => null) } },
        { provide: getRepositoryToken(WaitlistEntry), useValue: { update: jest.fn(async () => ({ affected: 0 })) } },
        // email напоминаний + gRPC-клиент reminder'ов (вердиктные хуки)
        { provide: getRepositoryToken(User), useValue: { findOneByOrFail: jest.fn() } },
        { provide: RemindersClient, useValue: { schedule: jest.fn(async () => ({ status: 'SCHEDULED' })), cancel: jest.fn(async () => ({ status: 'CANCELLED' })) } },
        // Тарификатор: базовая цена без факторов (ценовые кейсы — в pricing.int)
        { provide: PricingClient, useValue: { quote: jest.fn(async (input: { basePriceRub: number }) => ({ priceRub: input.basePriceRub, basePriceRub: input.basePriceRub, factors: [], occupied: 0, capacity: 80 })) } },
        { provide: AmqpConnection, useValue: { publish: jest.fn(), connected: true } },
        {
          provide: DataSource,
          useValue: {
            query: jest.fn(async () => []),
            transaction: (cb: (e: typeof em) => unknown) => cb(em),
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
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address() as AddressInfo;
    httpBase = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/api/seats`;

    // витрина: два фильма с одним сеансом каждый
    await moviesRepo.save({
      title: 'WS Тест',
      priceRub: 100,
      sessions: [{ hall: 'IMAX', startsAt: new Date(Date.now() + 86_400_000) }],
    } as unknown as Movie);
    await moviesRepo.save({
      title: 'Другой фильм',
      priceRub: 150,
      sessions: [{ hall: 'Красный', startsAt: new Date(Date.now() + 2 * 86_400_000) }],
    } as unknown as Movie);
    sessionsRepo.rows = moviesRepo.rows.flatMap((m) => m.sessions ?? []);
    sessionId = sessionsRepo.rows[0].id;
    otherSessionId = sessionsRepo.rows[1].id;

    const jwt = moduleRef.get(JwtService);
    bearer = `Bearer ${await jwt.signAsync({
      sub: 'user-a',
      email: 'user-a@test.local',
      name: 'Анна Тест',
      role: 'user',
    })}`;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createBooking(seat: string, sid = sessionId): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Authorization', bearer)
      .send({ sessionId: sid, customerName: 'Анна Тест', seats: [seat] });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('subscribe → первичный снапшот с уже занятым местом', async () => {
    occupancyRepo.rows.push({
      id: randomUUID(),
      sessionId,
      seat: '1-1',
      bookingId: randomUUID(),
      createdAt: new Date(),
    } as SeatOccupancy);

    const socket = await connect();
    try {
      subscribe(socket, sessionId);
      const frame = await nextFrame(socket);
      expect(frame.type).toBe('snapshot');
      if (frame.type !== 'snapshot') return;
      expect(frame.data.sessionId).toBe(sessionId);
      expect(frame.data.occupied).toEqual(['1-1']);
      expect(frame.data.free).toBe(79);
    } finally {
      socket.close();
    }
  });

  it('чужая покупка → снапшот с новым занятым местом в той же комнате', async () => {
    const socket = await connect();
    try {
      subscribe(socket, sessionId);
      await nextFrame(socket); // первичный снапшот

      // слушатель вешаем ДО мутации: кадр летит асинхронно и не ждёт ответа POST
      const framePromise = nextFrame(socket);
      await createBooking('5-5');
      const frame = await framePromise;

      expect(frame.type).toBe('snapshot');
      if (frame.type !== 'snapshot') return;
      expect(frame.data.occupied).toEqual(expect.arrayContaining(['1-1', '5-5']));
      expect(frame.data.free).toBe(78);
    } finally {
      socket.close();
    }
  });

  it('отмена неоплаченной → снапшот возвращает место в продажу', async () => {
    const socket = await connect();
    try {
      subscribe(socket, sessionId);
      await nextFrame(socket);

      const taken = nextFrame(socket);
      const bookingId = await createBooking('7-7');
      await taken; // заняли

      const freed = nextFrame(socket);
      const res = await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/cancel`)
        .set('Authorization', bearer);
      expect(res.status).toBe(200);
      const frame = await freed;

      expect(frame.type).toBe('snapshot');
      if (frame.type !== 'snapshot') return;
      expect(frame.data.occupied).not.toContain('7-7');
      expect(frame.data.free).toBe(78);
    } finally {
      socket.close();
    }
  });

  it('двум клиентам комнаты кадр уходит обоим; подписчик чужого сеанса не слышит', async () => {
    const first = await connect();
    const second = await connect();
    const stranger = await connect();
    try {
      subscribe(first, sessionId);
      subscribe(second, sessionId);
      subscribe(stranger, otherSessionId);
      await nextFrame(first);
      await nextFrame(second);
      await nextFrame(stranger);

      const firstFrame = nextFrame(first, 2000);
      const secondFrame = nextFrame(second, 2000);
      const strangerFrame = frameIfAny(stranger, 500);
      await createBooking('3-3');

      expect(await firstFrame).toMatchObject({
        type: 'snapshot',
        data: { occupied: expect.arrayContaining(['3-3']) },
      });
      expect(await secondFrame).toMatchObject({
        type: 'snapshot',
        data: { occupied: expect.arrayContaining(['3-3']) },
      });
      expect(await strangerFrame).toBeNull();
    } finally {
      first.close();
      second.close();
      stranger.close();
    }
  });

  it('несуществующий сеанс → error-кадр и закрытие соединения', async () => {
    const socket = await connect();
    try {
      subscribe(socket, randomUUID());
      const frame = await nextFrame(socket);
      expect(frame).toEqual({ type: 'error', message: 'Сеанс не найден' });

      const closed = new Promise<number>((resolve) =>
        socket.once('close', (code) => resolve(code)),
      );
      expect(await closed).toBe(1008);
    } finally {
      socket.close();
    }
  });

  it('мусорный кадр → error, но соединение живо и подписка работает', async () => {
    const socket = await connect();
    try {
      socket.send('это не json');
      const error = await nextFrame(socket);
      expect(error).toMatchObject({ type: 'error' });

      subscribe(socket, sessionId);
      const frame = await nextFrame(socket);
      expect(frame.type).toBe('snapshot');
    } finally {
      socket.close();
    }
  });
});

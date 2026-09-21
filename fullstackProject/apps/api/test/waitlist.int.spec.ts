import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { RolesGuard } from '../src/auth/roles.guard';
import { BookingStream } from '../src/bookings/booking-stream';
import { HALL_CAPACITY } from '../src/bookings/hall';
import { SeatOccupancy } from '../src/bookings/seat-occupancy.entity';
import { Movie, MovieDto } from '../src/movies/movie.entity';
import { Session } from '../src/movies/session.entity';
import { User } from '../src/users/user.entity';
import { WaitlistEntry } from '../src/waitlist/waitlist.entity';
import { WaitlistController } from '../src/waitlist/waitlist.controller';
import { WaitlistService } from '../src/waitlist/waitlist.service';

/**
 * Интеграционный тест листа ожидания: реальный HTTP-стек Nest (роутинг,
 * ValidationPipe, контроллеры → сервисы, JWT-гварды), но с in-memory
 * фейками Postgres. save() фейка честно бросает 23505 на дубль пары
 * (session_id, user_id) — как uq_waitlist_session_user в живой базе.
 */

type WaitWhere = { sessionId?: string; userId?: string };

class FakeWaitlistRepo {
  rows: WaitlistEntry[] = [];

  /** эмуляция загрузки relations: session по sessionId, как TypeORM */
  constructor(
    private readonly loadSession: (id: string) => Session | undefined,
  ) {}

  create(x: Partial<WaitlistEntry>): WaitlistEntry {
    return x as WaitlistEntry;
  }

  async save(x: WaitlistEntry): Promise<WaitlistEntry> {
    if (x.id) {
      // UPDATE по id: замена копией (detach), как реальный SQL
      const idx = this.rows.findIndex((r) => r.id === x.id);
      if (idx === -1) throw new Error('update неизвестной строки');
      const row = { ...this.rows[idx], ...x, updatedAt: new Date() };
      this.rows[idx] = row;
      return row;
    }
    if (
      this.rows.some(
        (r) => r.sessionId === x.sessionId && r.userId === x.userId,
      )
    ) {
      throw { code: '23505' }; // uq_waitlist_session_user
    }
    const row = {
      ...x,
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  private match(r: WaitlistEntry, where: WaitWhere = {}): boolean {
    return (
      (where.sessionId === undefined || r.sessionId === where.sessionId) &&
      (where.userId === undefined || r.userId === where.userId)
    );
  }

  async findOneBy(where: WaitWhere): Promise<WaitlistEntry | null> {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }

  async find(opts?: {
    where?: WaitWhere;
    relations?: string[];
  }): Promise<WaitlistEntry[]> {
    const rows = this.rows.filter((r) => this.match(r, opts?.where));
    if (opts?.relations?.includes('session')) {
      return rows.map((r) => ({
        ...r,
        session: this.loadSession(r.sessionId) ?? r.session,
      }));
    }
    return rows;
  }

  async update(
    criteria: { id: string },
    patch: Partial<WaitlistEntry>,
  ): Promise<{ affected: number }> {
    const idx = this.rows.findIndex((r) => r.id === criteria.id);
    if (idx === -1) return { affected: 0 };
    this.rows[idx] = { ...this.rows[idx], ...patch, updatedAt: new Date() };
    return { affected: 1 };
  }
}

describe('Лист ожидания: HTTP-интеграция (фейковые зависимости)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let entriesRepo: FakeWaitlistRepo;
  let waitlistService: WaitlistService;
  let moviesRepo: { findOneByOrFail: jest.Mock };
  let usersRepo: { findOneByOrFail: jest.Mock };
  let emitWaitlist: jest.Mock;
  /** опубликованные в RabbitMQ события */
  let published: { routingKey: string; payload: Record<string, unknown> }[];

  /** сеансы фикстуры: id → строка; join/my по ним */
  const sessions = new Map<string, Session>();

  /** сколько мест «занято» на сеансе фикстуре — полнота зала */
  let occupiedCount: number;

  let bearerA: string;
  let bearerB: string;

  /** полный будущий сеанс «Дюны» в IMAX */
  const seedSession = (overrides: Partial<Session> = {}): Session => {
    const movie = {
      id: randomUUID(),
      title: 'Дюна: Часть третья',
    } as Movie;
    const session: Session = {
      id: randomUUID(),
      movieId: movie.id,
      movie: movie as Movie & { sessions?: Session[] },
      hall: 'IMAX',
      startsAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      ...overrides,
    } as Session;
    sessions.set(session.id, session);
    return session;
  };

  /** чужая запись в очереди (раньше нашей — станет головой) */
  const seedEntry = (overrides: Partial<WaitlistEntry> = {}): WaitlistEntry => {
    const row: WaitlistEntry = {
      id: randomUUID(),
      sessionId: '',
      userId: 'someone-else',
      status: 'WAITING',
      queuedAt: new Date(Date.now() - 60_000),
      notifiedAt: null,
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
      ...overrides,
    } as WaitlistEntry;
    entriesRepo.rows.push(row);
    return row;
  };

  beforeAll(async () => {
    entriesRepo = new FakeWaitlistRepo((id) => sessions.get(id));
    occupiedCount = HALL_CAPACITY;
    published = [];
    emitWaitlist = jest.fn();

    // контекст уведомления при освобождении места (handleSeatReleased)
    moviesRepo = {
      findOneByOrFail: jest.fn(async (where: { id: string }) => ({
        id: where.id,
        title: 'Дюна: Часть третья',
      })),
    };
    usersRepo = {
      findOneByOrFail: jest.fn(async (where: { id: string }) => ({
        id: where.id,
        email: `${where.id}@test.local`,
        name: 'Гонец Очереди',
      })),
    };

    const sessionsRepo = {
      findOneByOrFail: jest.fn(async (where: { id: string }) => {
        const found = sessions.get(where.id);
        if (!found) throw new NotFoundException('Сеанс не найден');
        return found;
      }),
    };
    const occupancyRepo = {
      count: jest.fn(async () => occupiedCount),
      insert: jest.fn(),
      delete: jest.fn(),
      find: jest.fn(async () => []),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [WaitlistController],
      providers: [
        WaitlistService,
        { provide: getRepositoryToken(WaitlistEntry), useValue: entriesRepo },
        { provide: getRepositoryToken(Session), useValue: sessionsRepo },
        { provide: getRepositoryToken(SeatOccupancy), useValue: occupancyRepo },
        // для handleSeatReleased (контекст письма/уведомления)
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        {
          provide: AmqpConnection,
          useValue: {
            publish: (_ex: string, routingKey: string, payload: unknown) =>
              published.push({ routingKey, payload: payload as Record<string, unknown> }),
          },
        },
        { provide: BookingStream, useValue: { emitWaitlist } },
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

    waitlistService = moduleRef.get(WaitlistService);

    const jwt = moduleRef.get(JwtService);
    const sign = (sub: string, name: string, role: 'user' | 'admin') =>
      jwt.signAsync({ sub, email: `${sub}@test.local`, name, role });
    bearerA = `Bearer ${await sign('user-a', 'Анна Тест', 'user')}`;
    bearerB = `Bearer ${await sign('user-b', 'Борис Гонец', 'user')}`;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/waitlist/:sessionId', () => {
    it('401 без токена', async () => {
      const session = seedSession();
      const res = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`);
      expect(res.status).toBe(401);
    });

    it('404 на незнакомый сеанс, 400 на не-uuid', async () => {
      const notFound = await request(app.getHttpServer())
        .post(`/api/waitlist/${randomUUID()}`)
        .set('Authorization', bearerA);
      expect(notFound.status).toBe(404);

      const badUuid = await request(app.getHttpServer())
        .post('/api/waitlist/not-a-uuid')
        .set('Authorization', bearerA);
      expect(badUuid.status).toBe(400);
    });

    it('201: позиция среди WAITING — чужая запись раньше, наша вторая', async () => {
      const session = seedSession();
      seedEntry({ sessionId: session.id, userId: 'user-first' });

      const res = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        sessionId: session.id,
        userId: 'user-a',
        status: 'WAITING',
        position: 2,
      });
    });

    it('409 waitlistAlready при повторном входе тем же пользователем', async () => {
      const session = seedSession();
      const first = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);
      expect(first.status).toBe(201);

      const again = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('waitlistAlready');
    });

    it('409 sessionNotFull, когда в зале есть свободные места', async () => {
      const session = seedSession();
      occupiedCount = HALL_CAPACITY - 1;

      const res = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('sessionNotFull');
      occupiedCount = HALL_CAPACITY;
    });

    it('410 sessionPassed на начавшийся сеанс', async () => {
      const session = seedSession({
        startsAt: new Date(Date.now() - 3_600_000),
      });

      const res = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('sessionPassed');
    });
  });

  describe('DELETE /api/waitlist/:sessionId', () => {
    it('204 и запись LEFT; повторный leave — 404 waitlistEntryNotFound', async () => {
      const session = seedSession();
      await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);

      const gone = await request(app.getHttpServer())
        .delete(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);
      expect(gone.status).toBe(204);
      expect(
        entriesRepo.rows.find((r) => r.sessionId === session.id && r.userId === 'user-a')
          ?.status,
      ).toBe('LEFT');

      const again = await request(app.getHttpServer())
        .delete(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('waitlistEntryNotFound');

      // LEFT — история: /my её не показывает
      const mine = await request(app.getHttpServer())
        .get('/api/waitlist/my')
        .set('Authorization', bearerA);
      expect(
        mine.body.some((e: { sessionId: string }) => e.sessionId === session.id),
      ).toBe(false);
    });

    it('после leave повторный join — снова WAITING, но в конце очереди', async () => {
      const session = seedSession();
      seedEntry({ sessionId: session.id, userId: 'user-first' });
      seedEntry({ sessionId: session.id, userId: 'user-second' });

      // вошли, пока были «первыми» по времени среди своих правок
      const first = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);
      expect(first.body.position).toBe(3);

      await request(app.getHttpServer())
        .delete(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);

      const rejoined = await request(app.getHttpServer())
        .post(`/api/waitlist/${session.id}`)
        .set('Authorization', bearerA);
      expect(rejoined.status).toBe(201);
      expect(rejoined.body.position).toBe(3); // снова последняя: fresh queuedAt
    });
  });

  describe('GET /api/waitlist/my', () => {
    it('записи с контекстом фильма; позиция среди WAITING; сортировка по сеансу', async () => {
      const near = seedSession();
      const far = seedSession({
        hall: 'Красный',
        startsAt: new Date(Date.now() + 3 * 86_400_000),
      });
      seedEntry({ sessionId: near.id, userId: 'user-first' });
      seedEntry({ sessionId: far.id, userId: 'user-first' });

      await request(app.getHttpServer())
        .post(`/api/waitlist/${near.id}`)
        .set('Authorization', bearerA);
      await request(app.getHttpServer())
        .post(`/api/waitlist/${far.id}`)
        .set('Authorization', bearerA);

      const res = await request(app.getHttpServer())
        .get('/api/waitlist/my')
        .set('Authorization', bearerA);

      expect(res.status).toBe(200);
      // другие тесты тоже оставляют записи user-a — смотрим только свои сеансы
      const mine = res.body.filter(
        (e: { sessionId: string }) => e.sessionId === near.id || e.sessionId === far.id,
      );
      expect(mine).toHaveLength(2);
      // ближайший сеанс сверху
      expect(mine[0]).toMatchObject({
        sessionId: near.id,
        movieTitle: 'Дюна: Часть третья',
        hall: 'IMAX',
        status: 'WAITING',
        position: 2,
      });
      expect(mine[1]).toMatchObject({ sessionId: far.id, hall: 'Красный' });
    });

    it('прошедший сеанс лениво гасится из ответа', async () => {
      const past = seedSession({
        startsAt: new Date(Date.now() - 3_600_000),
      });
      entriesRepo.rows.push({
        id: randomUUID(),
        sessionId: past.id,
        userId: 'user-a',
        status: 'WAITING',
        queuedAt: new Date(),
        notifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as WaitlistEntry);

      const res = await request(app.getHttpServer())
        .get('/api/waitlist/my')
        .set('Authorization', bearerA);

      expect(res.body.some((e: { sessionId: string }) => e.sessionId === past.id)).toBe(false);
    });

    it('записи другого пользователя не видны', async () => {
      const session = seedSession();
      seedEntry({ sessionId: session.id, userId: 'user-first' });

      const mine = await request(app.getHttpServer())
        .get('/api/waitlist/my')
        .set('Authorization', bearerB);

      expect(mine.status).toBe(200);
      expect(mine.body).toEqual([]);
    });
  });

  describe('честная гонка: handleSeatReleased (консьюмер api.waitlist.released)', () => {
    const release = (sessionId: string, seats: string[] = ['5-7']) =>
      waitlistService.handleSeatReleased({
        sessionId,
        bookingId: randomUUID(),
        seats,
        reason: 'EXPIRED',
        releasedAt: new Date().toISOString(),
      });

    it('пустая очередь — письмо и SSE не уходят', async () => {
      const session = seedSession();
      published.length = 0;
      emitWaitlist.mockClear();

      await release(session.id);

      expect(published).toEqual([]);
      expect(emitWaitlist).not.toHaveBeenCalled();
    });

    it('голова WAITING → NOTIFIED: письмо с email и ссылкой, SSE с userId', async () => {
      const session = seedSession();
      const head = seedEntry({ sessionId: session.id, userId: 'user-a' });
      seedEntry({
        sessionId: session.id,
        userId: 'user-b',
        queuedAt: new Date(Date.now() - 30_000),
      });
      published.length = 0;
      emitWaitlist.mockClear();

      await release(session.id, ['3-4', '3-5']);

      const row = entriesRepo.rows.find((r) => r.id === head.id);
      expect(row?.status).toBe('NOTIFIED');
      expect(row?.notifiedAt).toBeInstanceOf(Date);

      expect(published).toEqual([
        expect.objectContaining({
          routingKey: 'user.waitlist.seat',
          payload: expect.objectContaining({
            email: 'user-a@test.local',
            userId: 'user-a',
            sessionId: session.id,
            movieTitle: 'Дюна: Часть третья',
          }),
        }),
      ]);
      expect((published[0].payload as { message: string }).message).toContain(
        '?movie=',
      );

      expect(emitWaitlist).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-a',
          sessionId: session.id,
          seats: ['3-4', '3-5'],
        }),
      );
    });

    it('второе освобождение — уведомлена следующая запись, не та же', async () => {
      const session = seedSession();
      const first = seedEntry({ sessionId: session.id, userId: 'user-a' });
      const second = seedEntry({
        sessionId: session.id,
        userId: 'user-b',
        queuedAt: new Date(Date.now() - 30_000),
      });

      await release(session.id);
      expect(entriesRepo.rows.find((r) => r.id === first.id)?.status).toBe('NOTIFIED');
      expect(entriesRepo.rows.find((r) => r.id === second.id)?.status).toBe('WAITING');

      published.length = 0;
      emitWaitlist.mockClear();
      await release(session.id);

      expect(entriesRepo.rows.find((r) => r.id === second.id)?.status).toBe('NOTIFIED');
      expect(published[0]?.payload).toMatchObject({ userId: 'user-b' });
      expect(emitWaitlist).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-b' }),
      );
    });

    it('все уведомлены — новых писем нет', async () => {
      const session = seedSession();
      const only = seedEntry({ sessionId: session.id, userId: 'user-a' });

      await release(session.id);
      published.length = 0;
      emitWaitlist.mockClear();

      await release(session.id);

      expect(entriesRepo.rows.find((r) => r.id === only.id)?.status).toBe('NOTIFIED');
      expect(published).toEqual([]);
      expect(emitWaitlist).not.toHaveBeenCalled();
    });
  });
});

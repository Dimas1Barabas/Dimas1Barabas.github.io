import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { BookingsController } from '../src/bookings/bookings.controller';
import { BookingsService } from '../src/bookings/bookings.service';
import { HealthController } from '../src/health/health.controller';
import { Movie } from '../src/movies/movie.entity';
import { MoviesController } from '../src/movies/movies.controller';
import { MoviesService } from '../src/movies/movies.service';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_CLIENT } from '../src/redis/redis.tokens';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Booking } from '../src/bookings/booking.entity';
import { randomUUID } from 'node:crypto';

/**
 * Интеграционный тест: реальный HTTP-стек Nest (роутинг, ValidationPipe,
 * контроллеры → сервисы), но с in-memory фейками Postgres/RabbitMQ/Redis.
 * Кэш — настоящий RedisService поверх Map, т.е. логика кэширования живая.
 */

class FakeMovieRepo {
  rows: Movie[] = [];

  async count(): Promise<number> {
    return this.rows.length;
  }

  async find(): Promise<Movie[]> {
    return [...this.rows];
  }

  create(x: Partial<Movie>): Movie {
    return x as Movie;
  }

  async save(entities: Movie | Movie[]): Promise<Movie | Movie[]> {
    const list = Array.isArray(entities) ? entities : [entities];
    for (const e of list) {
      // id-uuid, чтобы проходить @IsUUID() в DTO
      if (!e.id) e.id = randomUUID();
      if (!e.createdAt) e.createdAt = new Date();
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

class FakeBookingRepo {
  rows: Booking[] = [];

  create(x: Partial<Booking>): Booking {
    return x as Booking;
  }

  async save(booking: Booking): Promise<Booking> {
    if (!booking.id) {
      booking.id = randomUUID();
      booking.createdAt = new Date();
      booking.updatedAt = new Date();
      this.rows.unshift(booking); // новые сверху — как ORDER BY created_at DESC
    } else {
      booking.updatedAt = new Date();
    }
    return booking;
  }

  async find(): Promise<Booking[]> {
    return [...this.rows];
  }

  async findOneByOrFail(where: { id: string }): Promise<Booking> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Бронь не найдена');
    return found;
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

describe('CineBooking API: HTTP-интеграция (фейковые зависимости)', () => {
  let app: INestApplication;
  let moviesRepo: FakeMovieRepo;
  let bookingsRepo: FakeBookingRepo;
  let redisStore: Map<string, string>;
  let rabbitPublish: jest.Mock;
  let bookingsService: BookingsService;

  beforeAll(async () => {
    moviesRepo = new FakeMovieRepo();
    bookingsRepo = new FakeBookingRepo();
    redisStore = new Map();
    rabbitPublish = jest.fn();

    const moduleRef = await Test.createTestingModule({
      controllers: [MoviesController, BookingsController, HealthController],
      providers: [
        MoviesService,
        BookingsService,
        RedisService,
        { provide: REDIS_CLIENT, useValue: redisFake(redisStore) },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: AmqpConnection, useValue: { publish: rabbitPublish, connected: true } },
        { provide: DataSource, useValue: { query: jest.fn(async () => []) } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init(); // onModuleInit → посев фильмов

    bookingsService = moduleRef.get(BookingsService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/movies', () => {
    it('первый вызов — из «БД», с посевом 6 фильмов', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('db');
      expect(res.body.data).toHaveLength(6);
      expect(res.body.data[0]).toMatchObject({
        title: expect.any(String),
        priceRub: expect.any(Number),
        sessionAt: expect.any(String),
      });
    });

    it('повторный — из Redis-кэша (Map-фейк)', async () => {
      const res = await request(app.getHttpServer()).get('/api/movies');

      expect(res.status).toBe(200);
      expect(res.body.source).toBe('cache');
      expect(redisStore.has('movies:all')).toBe(true);
    });
  });

  describe('POST /api/bookings', () => {
    it('создаёт PENDING-бронь и публикует событие', async () => {
      const movies = (await request(app.getHttpServer()).get('/api/movies')).body.data;
      const movie = movies[0];

      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .send({ movieId: movie.id, customerName: 'Дмитрий', seats: 2 });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'PENDING',
        seats: 2,
        totalRub: movie.priceRub * 2,
        movieTitle: movie.title,
        customerName: 'Дмитрий',
      });

      expect(rabbitPublish).toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.objectContaining({ seats: 2, totalRub: movie.priceRub * 2 }),
      );
    });

    it.each([
      ['мест больше 8', { movieId: validUuid(), customerName: 'Дмитрий', seats: 9 }],
      ['имя из 1 символа', { movieId: validUuid(), customerName: 'Д', seats: 1 }],
      ['не-uuid movieId', { movieId: 'abc', customerName: 'Дмитрий', seats: 1 }],
      ['отрицательные места', { movieId: validUuid(), customerName: 'Дмитрий', seats: -1 }],
    ])('400 при невалидных данных: %s', async (_case, payload) => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .send(payload);

      expect(res.status).toBe(400);
    });

    it('404 на несуществующий фильм', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/bookings')
        .send({
          movieId: '00000000-0000-0000-0000-000000000000',
          customerName: 'Дмитрий',
          seats: 1,
        });

      expect(res.status).toBe(404);
    });
  });

  describe('полный цикл брони: вердикт Go-воркера', () => {
    it('handleProcessed → бронь становится CONFIRMED и видна в списке и статистике', async () => {
      const movies = (await request(app.getHttpServer()).get('/api/movies')).body.data;
      const created = (
        await request(app.getHttpServer()).post('/api/bookings').send({
          movieId: movies[0].id,
          customerName: 'Аноним',
          seats: 3,
        })
      ).body;

      // то, что в реальном стеке делает Go ticket-worker через RabbitMQ
      await bookingsService.handleProcessed({
        bookingId: created.id,
        status: 'CONFIRMED',
        message: 'Оплата прошла. Ряд 6, места 1, 2, 3.',
        processedBy: 'go-worker-1',
        processedAt: new Date().toISOString(),
      });

      const list = (
        await request(app.getHttpServer()).get('/api/bookings')
      ).body;
      const updated = list.find((b: { id: string }) => b.id === created.id);

      expect(updated.status).toBe('CONFIRMED');
      expect(updated.message).toContain('Ряд 6');
      expect(updated.processedBy).toBe('go-worker-1');
      expect(updated.processedAt).toBeTruthy();

      const stats = (
        await request(app.getHttpServer()).get('/api/bookings/stats')
      ).body;
      expect(stats.CONFIRMED).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /api/health', () => {
    it('все фейки живы → ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks).toEqual({
        postgres: 'up',
        redis: 'up',
        rabbitmq: 'up',
      });
    });
  });
});

function redisFake(store: Map<string, string>) {
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
function validUuid(): string {
  return '00000000-0000-4000-8000-000000000001';
}

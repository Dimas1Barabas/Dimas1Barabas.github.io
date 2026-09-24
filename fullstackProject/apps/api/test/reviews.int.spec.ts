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
import { Booking } from '../src/bookings/booking.entity';
import { Movie } from '../src/movies/movie.entity';
import { MoviesController } from '../src/movies/movies.controller';
import { MoviesService } from '../src/movies/movies.service';
import { RedisService } from '../src/redis/redis.service';
import { REDIS_CLIENT } from '../src/redis/redis.tokens';
import { Review } from '../src/reviews/review.entity';
import { ReviewsController } from '../src/reviews/reviews.controller';
import { ReviewsService } from '../src/reviews/reviews.service';
import { DataSource } from 'typeorm';

/**
 * Интеграционный тест отзывов: реальный HTTP-стек Nest (роутинг,
 * ValidationPipe, контроллеры → сервисы, JWT/roles-гварды), но с
 * in-memory фейками Postgres/Redis. Кэш — настоящий RedisService
 * поверх Map: после отзыва каталог обязан покинуть кэш (рейтинг).
 * «Транзакция» выполняет callback с эмуляцией EntityManager:
 * save дубля отзыва падает кодом 23505 — как uq-констрейнт.
 */

class FakeMovieRepo {
  rows: Movie[] = [];

  async count(): Promise<number> {
    return this.rows.length;
  }

  async find(_opts?: { relations?: unknown }): Promise<Movie[]> {
    return [...this.rows];
  }

  create(x: Partial<Movie>): Movie {
    return x as Movie;
  }

  async save(x: Movie): Promise<Movie> {
    if (!this.rows.includes(x)) this.rows.push(x);
    return x;
  }

  async findOneByOrFail(where: { id: string }): Promise<Movie> {
    const found = this.rows.find((r) => r.id === where.id);
    if (!found) throw new NotFoundException('Фильм не найден');
    return found;
  }
}

class FakeBookingRepo {
  rows: Booking[] = [];

  async findOneBy(where: {
    userId?: string;
    movieId?: string;
    status?: string;
  }): Promise<Booking | null> {
    return (
      this.rows.find(
        (r) =>
          (!where.userId || r.userId === where.userId) &&
          (!where.movieId || r.movieId === where.movieId) &&
          (!where.status || r.status === where.status),
      ) ?? null
    );
  }
}

describe('Отзывы и рейтинги: HTTP-интеграция (фейковые зависимости)', () => {
  /** совпадает с дефолтом JwtStrategy ('dev-cine-secret') */
  const AUTH_SECRET = 'dev-cine-secret';

  let app: INestApplication;
  let moviesRepo: FakeMovieRepo;
  let bookingsRepo: FakeBookingRepo;
  let reviews: Review[] = [];
  let redisStore: Map<string, string>;
  /** публикация сигналов КиноСоветнику */
  let rabbit: { publish: jest.Mock };
  /** фильм, на который пишем отзывы */
  let movieId: string;

  /** Authorization: автор брони, чужак и администратор */
  let bearer: string;
  let bearerB: string;
  let bearerAdmin: string;

  const payload = () => ({ rating: 4, text: 'Затянул с первых минут, советую!' });

  beforeAll(async () => {
    moviesRepo = new FakeMovieRepo();
    bookingsRepo = new FakeBookingRepo();
    reviews = [];
    redisStore = new Map();
    rabbit = { publish: jest.fn() };

    movieId = randomUUID();
    moviesRepo.rows.push({
      id: movieId,
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
      createdAt: new Date(),
    } as Movie);

    // эмуляция EntityManager из DataSource.transaction
    const em = {
      create: (_entity: unknown, x: Partial<Review>) => x,
      /** INSERT отзыва: дубль (userId, movieId) → 23505, как uq-констрейнт */
      save: (x: Partial<Review>): Promise<Review> => {
        if (
          reviews.some((r) => r.userId === x.userId && r.movieId === x.movieId)
        ) {
          return Promise.reject(
            Object.assign(new Error('dup'), { code: '23505' }),
          );
        }
        const saved: Review = {
          movie: moviesRepo.rows[0],
          user: { name: 'тест' } as Review['user'],
          createdAt: new Date(),
          updatedAt: new Date(),
          ...x,
          id: randomUUID(),
        } as Review;
        reviews.unshift(saved); // новые сверху — как ORDER BY created_at DESC
        return Promise.resolve(saved);
      },
      delete: (_entity: unknown, criteria: { id: string }): Promise<{ affected: number }> => {
        const before = reviews.length;
        reviews = reviews.filter((r) => r.id !== criteria.id);
        return Promise.resolve({ affected: before - reviews.length });
      },
      /** условный UPDATE агрегатов фильма */
      update: (
        _entity: unknown,
        criteria: { id: string },
        patch: Partial<Movie>,
      ): Promise<{ affected: number }> => {
        const row = moviesRepo.rows.find((r) => r.id === criteria.id);
        if (row) Object.assign(row, patch);
        return Promise.resolve({ affected: row ? 1 : 0 });
      },
      /** AVG/COUNT по отзывам фильма — как пересчёт рейтинга */
      createQueryBuilder: () => {
        let movieId_ = '';
        const qb: Record<string, unknown> = {};
        const chain = () => qb;
        qb.select = chain;
        qb.addSelect = chain;
        qb.where = (_sql: string, params?: { movieId?: string }) => {
          movieId_ = params?.movieId ?? '';
          return qb;
        };
        qb.getRawOne = async () => {
          const mine = reviews.filter((r) => r.movieId === movieId_);
          if (!mine.length) return null;
          const avg = mine.reduce((acc, r) => acc + r.rating, 0) / mine.length;
          return { avg: String(avg), count: String(mine.length) };
        };
        return qb;
      },
    };

    const fakeReviewRepo = {
      find: async (opts?: { where?: { movieId?: string } }) =>
        reviews.filter((r) => r.movieId === opts?.where?.movieId),
      findOneByOrFail: async (where: { id: string; movieId: string }) => {
        const found = reviews.find(
          (r) => r.id === where.id && r.movieId === where.movieId,
        );
        if (!found) throw new NotFoundException('Отзыв не найден');
        return found;
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        JwtModule.register({ secret: AUTH_SECRET, signOptions: { expiresIn: '1h' } }),
      ],
      controllers: [MoviesController, ReviewsController],
      providers: [
        MoviesService,
        ReviewsService,
        RedisService,
        { provide: REDIS_CLIENT, useValue: redisFake(redisStore) },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
        { provide: getRepositoryToken(Review), useValue: fakeReviewRepo },
        { provide: AmqpConnection, useValue: rabbit },
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

  /** каталог одним запросом (кэш живой — как в реальном стеке) */
  async function movieFromCatalog(): Promise<{
    ratingAvg: number;
    ratingCount: number;
  }> {
    const res = await request(app.getHttpServer()).get('/api/movies');
    return res.body.data.find((m: { id: string }) => m.id === movieId);
  }

  describe('GET /api/movies/:id/reviews', () => {
    it('публичен: без токена отдаёт пустой список', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/movies/${movieId}/reviews`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('не-uuid id — 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/movies/not-a-uuid/reviews');

      expect(res.status).toBe(400);
    });

    it('неизвестный uuid — 404', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/movies/${randomUUID()}/reviews`);

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/movies/:id/reviews', () => {
    it('без токена — 401', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/reviews`)
        .send(payload());

      expect(res.status).toBe(401);
    });

    it('без подтверждённой брони — 403', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/reviews`)
        .set('Authorization', bearer)
        .send(payload());

      expect(res.status).toBe(403);
    });

    it('кривое тело — 400 (оценка вне 1–5, короткий текст)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/reviews`)
        .set('Authorization', bearer)
        .send({ rating: 6, text: 'коротко' });

      expect(res.status).toBe(400);
    });

    it('201 после подтверждённой брони; рейтинг появляется в каталоге', async () => {
      // прогрев кэша каталога — отзыв обязан его сбросить
      await movieFromCatalog();

      bookingsRepo.rows.push({
        id: randomUUID(),
        movieId,
        userId: 'user-a',
        status: 'CONFIRMED',
      } as Booking);

      const res = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/reviews`)
        .set('Authorization', bearer)
        .send(payload());

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        movieId,
        userId: 'user-a',
        authorName: 'Анна Тест',
        rating: 4,
        text: 'Затянул с первых минут, советую!',
      });
      expect(res.body.id).toEqual(expect.any(String));

      // каталог покинул кэш: рейтинг читается из «БД»
      const movie = await movieFromCatalog();
      expect(movie).toMatchObject({ ratingAvg: 4, ratingCount: 1 });

      // КиноСоветник получил сигнал: жанр и рейтинг отзыва, dedup по reviewId
      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'recommendation.review.created',
        {
          userId: 'user-a',
          movieId,
          movieTitle: 'Рекурсия',
          genre: 'хоррор',
          rating: 4,
          reviewId: res.body.id,
          occurredAt: expect.any(String),
        },
      );
    });

    it('дубль отзыва — 409 reviewExists', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/reviews`)
        .set('Authorization', bearer)
        .send({ rating: 5, text: 'Передумал: теперь пять звёзд!' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('reviewExists');
    });
  });

  describe('DELETE /api/movies/:id/reviews/:reviewId', () => {
    let reviewId: string;

    beforeAll(async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/movies/${movieId}/reviews`);
      reviewId = res.body[0].id;
    });

    it('чужой отзыв — 403', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/api/movies/${movieId}/reviews/${reviewId}`)
        .set('Authorization', bearerB);

      expect(res.status).toBe(403);
    });

    it('свой — 204, агрегаты в каталоге обнуляются', async () => {
      await movieFromCatalog(); // прогрев кэша

      const res = await request(app.getHttpServer())
        .delete(`/api/movies/${movieId}/reviews/${reviewId}`)
        .set('Authorization', bearer);

      expect(res.status).toBe(204);

      const movie = await movieFromCatalog();
      expect(movie).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
      const list = await request(app.getHttpServer())
        .get(`/api/movies/${movieId}/reviews`);
      expect(list.body).toEqual([]);
    });

    it('админ удаляет чужой отзыв', async () => {
      // Борис покупает и пишет
      bookingsRepo.rows.push({
        id: randomUUID(),
        movieId,
        userId: 'user-b',
        status: 'CONFIRMED',
      } as Booking);
      const created = await request(app.getHttpServer())
        .post(`/api/movies/${movieId}/reviews`)
        .set('Authorization', bearerB)
        .send({ rating: 2, text: 'Не моё, но звук был хороший.' });

      expect(created.status).toBe(201);

      const res = await request(app.getHttpServer())
        .delete(`/api/movies/${movieId}/reviews/${created.body.id}`)
        .set('Authorization', bearerAdmin);

      expect(res.status).toBe(204);
    });
  });
});

/** Map-фейк ioredis-клиента (как в http.int.spec) */
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

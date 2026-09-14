import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { Booking } from '../bookings/booking.entity';
import { Movie } from '../movies/movie.entity';
import { MOVIES_KEY, movieKey } from '../movies/movies.service';
import { RedisService } from '../redis/redis.service';
import { REDIS_CLIENT } from '../redis/redis.tokens';
import { CreateReviewDto } from './dto/create-review.dto';
import { Review } from './review.entity';
import { ReviewsService } from './reviews.service';

/**
 * Юнит-тест отзывов: jest.Mock-репозитории и «транзакция», выполняющая
 * callback с эмуляцией EntityManager; save дубля падает кодом 23505 —
 * как uq-констрейнт. Redis — настоящий сервис поверх Map-фейка,
 * чтобы проверять сброс кэш-ключей каталога.
 */

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

/** автор отзыва из JWT */
const authUser: AuthUser = {
  id: 'user-1',
  email: 'dmitry@example.com',
  name: 'Дмитрий',
  role: 'user',
};

function reviewFixture(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    movieId: 'movie-1',
    movie: movieFixture,
    userId: 'user-1',
    user: { name: 'Дмитрий' } as Review['user'],
    rating: 5,
    text: 'Смотрел не отрываясь!',
    createdAt: new Date('2026-09-10T10:00:00Z'),
    updatedAt: new Date('2026-09-10T10:00:00Z'),
    ...overrides,
  };
}

describe('ReviewsService (unit)', () => {
  let service: ReviewsService;
  let reviewsRepo: { find: jest.Mock; findOneByOrFail: jest.Mock };
  let moviesRepo: { findOneByOrFail: jest.Mock };
  let bookingsRepo: { findOneBy: jest.Mock };
  let redisStore: Map<string, string>;
  /** что делала транзакция с EntityManager */
  let emSave: jest.Mock;
  let emDelete: jest.Mock;
  let emUpdate: jest.Mock;
  let emGetRawOne: jest.Mock;

  beforeEach(async () => {
    reviewsRepo = {
      find: jest.fn(),
      findOneByOrFail: jest.fn(),
    };
    moviesRepo = { findOneByOrFail: jest.fn(async () => movieFixture) };
    // eligibility: по умолчанию подтверждённая бронь находится
    bookingsRepo = { findOneBy: jest.fn(async () => ({} as Booking)) };
    redisStore = new Map();
    emSave = jest.fn(async (x: Partial<Review>) => reviewFixture(x));
    emDelete = jest.fn(async () => ({ affected: 1 }));
    emUpdate = jest.fn(async () => ({ affected: 1 }));
    // AVG/COUNT из pg: строки
    emGetRawOne = jest.fn().mockResolvedValue({ avg: '4.5000', count: '2' });

    const em = {
      create: (_entity: unknown, x: Partial<Review>) => x,
      save: emSave,
      delete: emDelete,
      update: emUpdate,
      createQueryBuilder: () => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: emGetRawOne,
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReviewsService,
        RedisService,
        { provide: REDIS_CLIENT, useValue: redisFake(redisStore) },
        {
          provide: DataSource,
          useValue: { transaction: (cb: (e: unknown) => unknown) => cb(em) },
        },
        { provide: getRepositoryToken(Review), useValue: reviewsRepo },
        { provide: getRepositoryToken(Movie), useValue: moviesRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingsRepo },
      ],
    }).compile();

    service = moduleRef.get(ReviewsService);
  });

  describe('create', () => {
    const dto: CreateReviewDto = {
      rating: 5,
      text: '  Смотрел не отрываясь!  ',
    };

    it('сохраняет отзыв, пересчитывает агрегаты и сбрасывает кэш каталога', async () => {
      redisStore.set(MOVIES_KEY, 'stale');
      redisStore.set(movieKey('movie-1'), 'stale');

      const created = await service.create('movie-1', dto, authUser);

      expect(emSave).toHaveBeenCalledWith(
        expect.objectContaining({
          movieId: 'movie-1',
          userId: 'user-1',
          rating: 5,
          text: 'Смотрел не отрываясь!',
        }),
      );
      // агрегаты пересчитаны от источника: AVG-строка → число
      expect(emUpdate).toHaveBeenCalledWith(
        Movie,
        { id: 'movie-1' },
        { ratingAvg: 4.5, ratingCount: 2 },
      );
      // рейтинг на карточках — каталог и карточка фильма покинули кэш
      expect(redisStore.has(MOVIES_KEY)).toBe(false);
      expect(redisStore.has(movieKey('movie-1'))).toBe(false);
      // имя автора — из JWT (relation в транзакции не грузили)
      expect(created).toMatchObject({
        authorName: 'Дмитрий',
        rating: 5,
        text: 'Смотрел не отрываясь!',
      });
    });

    it('право на отзыв проверяет по подтверждённой брони', async () => {
      await service.create('movie-1', dto, authUser);

      expect(bookingsRepo.findOneBy).toHaveBeenCalledWith({
        userId: 'user-1',
        movieId: 'movie-1',
        status: 'CONFIRMED',
      });
    });

    it('без подтверждённой брони — 403, ничего не пишет', async () => {
      bookingsRepo.findOneBy.mockResolvedValue(null);

      await expect(service.create('movie-1', dto, authUser)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(emSave).not.toHaveBeenCalled();
    });

    it('фильма нет — 404', async () => {
      moviesRepo.findOneByOrFail.mockRejectedValue(
        new NotFoundException('Фильм не найден'),
      );

      await expect(service.create('movie-42', dto, authUser)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('дубль отзыва (23505) — 409 reviewExists, агрегаты не трогает', async () => {
      emSave.mockRejectedValue(
        Object.assign(new Error('dup'), { code: '23505' }),
      );

      const err = await service
        .create('movie-1', dto, authUser)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err).toMatchObject({ response: { code: 'reviewExists' } });
      expect(emUpdate).not.toHaveBeenCalled();
    });
  });

  describe('listForMovie', () => {
    it('отдаёт DTO с именем автора, свежие сверху', async () => {
      reviewsRepo.find.mockResolvedValue([
        reviewFixture(),
        reviewFixture({ id: 'review-2', rating: 3 }),
      ]);

      const list = await service.listForMovie('movie-1');

      expect(reviewsRepo.find).toHaveBeenCalledWith({
        where: { movieId: 'movie-1' },
        order: { createdAt: 'DESC' },
        relations: { user: true },
      });
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        id: 'review-1',
        authorName: 'Дмитрий',
        rating: 5,
      });
    });

    it('фильма нет — 404', async () => {
      moviesRepo.findOneByOrFail.mockRejectedValue(
        new NotFoundException('Фильм не найден'),
      );

      await expect(service.listForMovie('movie-42')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('свой отзыв: удаляет, пересчитывает агрегаты, сбрасывает кэш', async () => {
      reviewsRepo.findOneByOrFail.mockResolvedValue(reviewFixture());
      redisStore.set(MOVIES_KEY, 'stale');

      await service.remove('movie-1', 'review-1', authUser);

      expect(emDelete).toHaveBeenCalledWith(Review, { id: 'review-1' });
      expect(emUpdate).toHaveBeenCalled();
      expect(redisStore.has(MOVIES_KEY)).toBe(false);
    });

    it('чужой отзыв — 403, ничего не удаляет', async () => {
      reviewsRepo.findOneByOrFail.mockResolvedValue(
        reviewFixture({ userId: 'user-2' }),
      );

      await expect(
        service.remove('movie-1', 'review-1', authUser),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(emDelete).not.toHaveBeenCalled();
    });

    it('админ может удалить чужой отзыв', async () => {
      reviewsRepo.findOneByOrFail.mockResolvedValue(
        reviewFixture({ userId: 'user-2' }),
      );
      const admin: AuthUser = { ...authUser, id: 'admin-1', role: 'admin' };

      await expect(
        service.remove('movie-1', 'review-1', admin),
      ).resolves.toBeUndefined();
      expect(emDelete).toHaveBeenCalledWith(Review, { id: 'review-1' });
    });

    it('отзыв другого фильма — 404 (поиск скоуплен по movieId)', async () => {
      reviewsRepo.findOneByOrFail.mockRejectedValue(
        new NotFoundException('Отзыв не найден'),
      );

      await expect(
        service.remove('movie-42', 'review-1', authUser),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(reviewsRepo.findOneByOrFail).toHaveBeenCalledWith({
        id: 'review-1',
        movieId: 'movie-42',
      });
    });

    it('последний отзыв: агрегаты честно обнуляются', async () => {
      reviewsRepo.findOneByOrFail.mockResolvedValue(reviewFixture());
      emGetRawOne.mockResolvedValue(null); // отзывов больше нет

      await service.remove('movie-1', 'review-1', authUser);

      expect(emUpdate).toHaveBeenCalledWith(
        Movie,
        { id: 'movie-1' },
        { ratingAvg: 0, ratingCount: 0 },
      );
    });
  });
});

/** Map-фейк ioredis-клиента (как в movies.service.spec) */
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

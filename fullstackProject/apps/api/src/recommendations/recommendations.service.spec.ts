import { Test } from '@nestjs/testing';
import { MovieDto } from '../movies/movie.entity';
import { MoviesService } from '../movies/movies.service';
import { RedisService } from '../redis/redis.service';
import { REDIS_CLIENT } from '../redis/redis.tokens';
import {
  RecommendationCandidate,
  RecommendationsClient,
} from './recommendations.client';
import { RecommendationsService } from './recommendations.service';

/**
 * Юнит-тест фасада рекомендаций: клиент КиноСоветника и каталог — jest.Mock,
 * кэш — настоящий RedisService поверх Map-фейка (проверяем попадание,
 * TTL-поведение эмулируем прямыми del — как делает invalidateFor).
 */

const catalog: MovieDto[] = [
  {
    id: 'movie-1',
    title: 'Дюна',
    description: 'desc',
    genre: 'фантастика',
    genreIcon: '🪐',
    durationMin: 155,
    priceRub: 500,
    hue: 40,
    sessions: [],
    ratingAvg: 3,
    ratingCount: 3,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  } as unknown as MovieDto,
  {
    id: 'movie-2',
    title: 'Осенний вальс',
    description: 'desc',
    genre: 'драма',
    genreIcon: '🍂',
    durationMin: 100,
    priceRub: 400,
    hue: 20,
    sessions: [],
    ratingAvg: 4.9,
    ratingCount: 40,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  } as unknown as MovieDto,
];

describe('RecommendationsService (unit)', () => {
  let service: RecommendationsService;
  let recos: { forUser: jest.Mock };
  let movies: { findAll: jest.Mock };
  let redisStore: Map<string, string>;

  beforeEach(async () => {
    recos = { forUser: jest.fn() };
    movies = { findAll: jest.fn(async () => ({ source: 'db', data: catalog })) };
    redisStore = new Map();

    const moduleRef = await Test.createTestingModule({
      providers: [
        RecommendationsService,
        RedisService,
        { provide: REDIS_CLIENT, useValue: redisFake(redisStore) },
        { provide: RecommendationsClient, useValue: recos },
        { provide: MoviesService, useValue: movies },
      ],
    }).compile();

    service = moduleRef.get(RecommendationsService);
  });

  it('передаёт афишу кандидатами и возвращает топ с basis', async () => {
    recos.forUser.mockResolvedValue({
      basis: 'profile',
      items: [{ movieId: 'movie-2', title: 'Осенний вальс', genre: 'драма', score: 0.9, reason: 'высокий рейтинг зрителей' }],
    });

    const top = await service.my('user-1');

    const [userId, candidates, limit] = recos.forUser.mock.calls[0] as [
      string,
      RecommendationCandidate[],
      number,
    ];
    expect(userId).toBe('user-1');
    expect(limit).toBe(4);
    expect(candidates).toEqual([
      { movieId: 'movie-1', title: 'Дюна', genre: 'фантастика', ratingAvg: 3, ratingCount: 3 },
      { movieId: 'movie-2', title: 'Осенний вальс', genre: 'драма', ratingAvg: 4.9, ratingCount: 40 },
    ]);
    expect(top).toEqual({
      basis: 'profile',
      items: [{ movieId: 'movie-2', title: 'Осенний вальс', genre: 'драма', score: 0.9, reason: 'высокий рейтинг зрителей' }],
    });
  });

  it('сбой gRPC — не ошибка запроса: пустой топ с basis unavailable', async () => {
    recos.forUser.mockRejectedValue(new Error('connection refused'));

    const top = await service.my('user-1');

    expect(top).toEqual({ items: [], basis: 'unavailable' });
  });

  it('мусорный basis сервиса приводится к unavailable', async () => {
    recos.forUser.mockResolvedValue({ basis: '42', items: [] });

    const top = await service.my('user-1');

    expect(top.basis).toBe('unavailable');
  });

  it('кэш на 60 c: второй вызов не ходит в gRPC', async () => {
    recos.forUser.mockResolvedValue({ basis: 'popular', items: [] });

    await service.my('user-1');
    await service.my('user-1');

    expect(recos.forUser).toHaveBeenCalledTimes(1);
  });

  it('кэш зрителей изолирован', async () => {
    recos.forUser.mockResolvedValue({ basis: 'popular', items: [] });

    await service.my('user-1');
    await service.my('user-2');

    expect(recos.forUser).toHaveBeenCalledTimes(2);
    expect(recos.forUser.mock.calls[0][0]).toBe('user-1');
    expect(recos.forUser.mock.calls[1][0]).toBe('user-2');
  });

  it('invalidateFor гасит кэш — следующий вызов снова идёт в gRPC', async () => {
    recos.forUser.mockResolvedValue({ basis: 'popular', items: [] });

    await service.my('user-1');
    await service.invalidateFor('user-1');
    await service.my('user-1');

    expect(recos.forUser).toHaveBeenCalledTimes(2);
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
    setex: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    },
    del: async (...keys: string[]) => {
      keys.forEach((k) => store.delete(k));
    },
    ping: async () => 'PONG',
  };
}

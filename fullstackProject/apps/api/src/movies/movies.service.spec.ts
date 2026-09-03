import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RedisService } from '../redis/redis.service';
import { REDIS_CLIENT } from '../redis/redis.tokens';
import { Movie } from './movie.entity';
import { MoviesService } from './movies.service';

/**
 * Юнит-тест с настоящим RedisService, но фейковым ioredis-клиентом:
 * так проверяется именно логика кэширования (withCache), без Redis.
 */
describe('MoviesService (unit)', () => {
  let service: MoviesService;
  let repo: { count: jest.Mock; find: jest.Mock; create: jest.Mock; save: jest.Mock; findOneByOrFail: jest.Mock };
  let redisStore: Map<string, string>;
  let redisGet: jest.Mock;

  const movieFixture: Movie = {
    id: 'movie-1',
    title: 'Рекурсия',
    description: 'desc',
    genre: 'хоррор',
    genreIcon: '🌀',
    durationMin: 112,
    priceRub: 400,
    hue: 275,
    sessionAt: new Date('2026-09-05T19:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };

  beforeEach(async () => {
    repo = {
      count: jest.fn(async () => 1), // БД уже заполнена
      find: jest.fn(async () => [movieFixture]),
      findOneByOrFail: jest.fn(async () => movieFixture),
      create: jest.fn((x) => ({ ...x })),
      save: jest.fn(async (x) => x),
    };

    redisStore = new Map();
    redisGet = jest.fn(async (key: string) => redisStore.get(key) ?? null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MoviesService,
        RedisService,
        {
          provide: REDIS_CLIENT,
          useValue: {
            get: redisGet,
            set: jest.fn(async (key: string, value: string, _mode: string, _ttl: number) => {
              redisStore.set(key, value);
              return 'OK';
            }),
            del: jest.fn(),
            ping: jest.fn(async () => 'PONG'),
          },
        },
        { provide: getRepositoryToken(Movie), useValue: repo },
      ],
    }).compile();

    service = moduleRef.get(MoviesService);
    await moduleRef.init(); // срабатывает onModuleInit (посев)
  });

  it('не сеет фильмы, если БД не пуста', () => {
    expect(repo.count).toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('findAll: промах кэша → грузит из репозитория и кладёт в Redis', async () => {
    const first = await service.findAll();

    expect(first.source).toBe('db');
    expect(first.data[0].title).toBe('Рекурсия');
    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(redisStore.has('movies:all')).toBe(true);
  });

  it('findAll: попадание → отдаёт из кэша без похода в БД', async () => {
    await service.findAll(); // прогрев
    const second = await service.findAll();

    expect(second.source).toBe('cache');
    expect(repo.find).toHaveBeenCalledTimes(1); // повторно не ходили
    expect(redisGet).toHaveBeenCalledWith('movies:all');
  });

  it('сеет фильмы при пустой БД', async () => {
    repo.count.mockResolvedValue(0);
    const fresh = await Test.createTestingModule({
      providers: [
        MoviesService,
        RedisService,
        {
          provide: REDIS_CLIENT,
          useValue: {
            get: async () => null,
            set: async () => 'OK',
            del: jest.fn(),
            ping: async () => 'PONG',
          },
        },
        { provide: getRepositoryToken(Movie), useValue: repo },
      ],
    }).compile();
    const freshService = fresh.get(MoviesService);
    await fresh.init();

    expect(repo.save).toHaveBeenCalled();
  });
});

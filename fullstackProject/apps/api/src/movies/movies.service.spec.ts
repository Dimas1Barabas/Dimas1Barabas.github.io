import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RedisService } from '../redis/redis.service';
import { REDIS_CLIENT } from '../redis/redis.tokens';
import { Movie } from './movie.entity';
import { MoviesService } from './movies.service';
import { Session, toSessionDtos } from './session.entity';

/**
 * Юнит-тест с настоящим RedisService, но фейковым ioredis-клиентом:
 * так проверяется именно логика кэширования (withCache), без Redis.
 */

function movieFixture(overrides: Partial<Movie> = {}): Movie {
  return {
    id: 'movie-1',
    title: 'Рекурсия',
    description: 'desc',
    genre: 'хоррор',
    genreIcon: '🌀',
    durationMin: 112,
    priceRub: 400,
    hue: 275,
    sessions: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    movieId: 'movie-1',
    movie: movieFixture(),
    hall: 'IMAX',
    startsAt: new Date('2026-09-05T19:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

/** общий набор фейковых репозиториев и Redis */
function makeProviders(
  repo: Record<string, jest.Mock>,
  store: Map<string, string>,
  get: (key: string) => Promise<string | null> = async (key) =>
    store.get(key) ?? null,
) {
  return [
    MoviesService,
    RedisService,
    {
      provide: REDIS_CLIENT,
      useValue: {
        get,
        set: async (key: string, value: string) => {
          store.set(key, value);
          return 'OK';
        },
        del: async (...keys: string[]) => {
          keys.forEach((k) => store.delete(k));
        },
        ping: async () => 'PONG',
      },
    },
    { provide: getRepositoryToken(Movie), useValue: repo },
  ];
}

describe('MoviesService (unit)', () => {
  let service: MoviesService;
  let repo: {
    count: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOneByOrFail: jest.Mock;
  };
  let redisStore: Map<string, string>;
  let redisGet: jest.Mock;

  const late = sessionFixture({
    id: 'session-late',
    hall: 'IMAX',
    startsAt: new Date('2030-01-01T21:00:00Z'),
  });
  const soon = sessionFixture({
    id: 'session-soon',
    hall: 'Красный',
    startsAt: new Date('2026-09-04T15:00:00Z'),
  });
  /** порядок в массиве — позже первым, DTO должен отсортировать по startsAt */
  const withSessions = movieFixture({ sessions: [late, soon] });

  beforeEach(async () => {
    repo = {
      count: jest.fn(async () => 1), // БД уже заполнена
      find: jest.fn(async () => [withSessions]),
      findOneByOrFail: jest.fn(async () => withSessions),
      create: jest.fn((x) => ({ ...x })),
      // эмуляция cascade: сеансы получают id и movieId
      save: jest.fn(async (x) => x),
    };

    redisStore = new Map();
    redisGet = jest.fn(async (key: string) => redisStore.get(key) ?? null);

    const moduleRef = await Test.createTestingModule({
      providers: makeProviders(repo, redisStore, redisGet),
    }).compile();

    service = moduleRef.get(MoviesService);
    await moduleRef.init(); // срабатывает onModuleInit (посев)
  });

  it('не сеет фильмы, если БД не пуста', () => {
    expect(repo.count).toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('findAll: промах кэша → грузит из репозитория и кладёт в Redis (ключ v2)', async () => {
    const first = await service.findAll();

    expect(first.source).toBe('db');
    expect(first.data[0].title).toBe('Рекурсия');
    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(redisStore.has('movies:all:v2')).toBe(true);
  });

  it('findAll: попадание → отдаёт из кэша без похода в БД', async () => {
    await service.findAll(); // прогрев
    const second = await service.findAll();

    expect(second.source).toBe('cache');
    expect(repo.find).toHaveBeenCalledTimes(1); // повторно не ходили
    expect(redisGet).toHaveBeenCalledWith('movies:all:v2');
  });

  it('findAll: DTO с сеансами по возрастанию времени, без sessionAt', async () => {
    const { data } = await service.findAll();

    expect(data[0].sessions).toHaveLength(2);
    expect(data[0].sessions.map((s) => s.id)).toEqual(['session-soon', 'session-late']);
    expect(data[0].sessions[0]).toEqual({
      id: 'session-soon',
      hall: 'Красный',
      startsAt: '2026-09-04T15:00:00.000Z',
    });
    expect('sessionAt' in data[0]).toBe(false);
  });

  it('findAll: сортирует афишу по ближайшему сеансу', async () => {
    const earlier = movieFixture({
      id: 'movie-earlier',
      sessions: [
        sessionFixture({
          id: 'session-mid',
          startsAt: new Date('2026-09-03T10:00:00Z'),
        }),
      ],
    });
    repo.find.mockResolvedValue([withSessions, earlier]);

    const { data } = await service.findAll();

    expect(data.map((m) => m.id)).toEqual(['movie-earlier', 'movie-1']);
  });

  it('сеет фильмы с сеансами при пустой БД', async () => {
    repo.count.mockResolvedValue(0);
    const fresh = await Test.createTestingModule({
      providers: makeProviders(repo, new Map()),
    }).compile();
    const freshService = fresh.get(MoviesService);
    await fresh.init();

    expect(repo.save).toHaveBeenCalled();
    const seeded = repo.save.mock.calls[0][0] as { sessions: unknown[] }[];
    expect(seeded.length).toBeGreaterThan(0);
    // каждый посевной фильм несёт свои сеансы
    expect(seeded.every((m) => Array.isArray(m.sessions) && m.sessions.length >= 2)).toBe(
      true,
    );
  });

  it('create: собирает фильм с сеансами и сбрасывает кэш', async () => {
    repo.save.mockImplementation(async (x: Movie) => ({
      ...x,
      sessions: (x.sessions ?? []).map((s, i) => ({
        ...s,
        id: `session-new-${i}`,
      })),
    }));
    redisStore.set('movies:all:v2', 'stale');

    const created = await service.create({
      title: 'Новый',
      description: 'desc',
      genre: 'тест',
      genreIcon: '🧪',
      durationMin: 100,
      priceRub: 300,
      hue: 10,
      sessions: [
        { hall: 'IMAX', startsAt: '2026-12-31T21:00:00Z' },
        { hall: 'Красный', startsAt: '2027-01-01T13:00:00Z' },
      ],
    });

    expect(created.sessions).toHaveLength(2);
    expect(created.sessions[0]).toMatchObject({
      id: 'session-new-0',
      hall: 'IMAX',
    });
    expect(redisStore.has('movies:all:v2')).toBe(false);
  });
});

describe('toSessionDtos', () => {
  it('сортирует по startsAt и переживает undefined', () => {
    const a = sessionFixture({ startsAt: new Date('2030-01-02T10:00:00Z') });
    const b = sessionFixture({ startsAt: new Date('2030-01-01T10:00:00Z') });

    expect(toSessionDtos([a, b]).map((s) => s.startsAt)).toEqual([
      '2030-01-01T10:00:00.000Z',
      '2030-01-02T10:00:00.000Z',
    ]);
    expect(toSessionDtos(undefined)).toEqual([]);
  });
});

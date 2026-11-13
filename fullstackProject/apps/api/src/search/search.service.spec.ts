import { Repository } from 'typeorm';
import { Movie, MovieDto } from '../movies/movie.entity';
import { MeiliStore, MovieDoc } from './meili.store';
import { SearchService } from './search.service';

/**
 * Юнит-уровень SearchService: фейковый стор Meilisearch (шпионы) и
 * фейковый репозиторий. Главные Contracts: бут не падает никогда
 * (движка нет/молчит — ворнинг), документы подсказки — минимальный
 * набор полей витрины.
 */

/** фейковый стор: все операции — шпионы, поведение — через overrides */
function makeStore(
  overrides: Partial<Record<'ensureIndex' | 'rebuild' | 'upsert', jest.Mock>> = {},
): MeiliStore {
  return {
    ensureIndex: jest.fn(async () => undefined),
    rebuild: jest.fn(async () => undefined),
    upsert: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as MeiliStore;
}

function movieRow(overrides: Partial<Movie> = {}): Movie {
  return {
    id: 'movie-1',
    title: 'Рекурсия',
    description: 'петля времени в исходниках',
    genre: 'фантастика',
    genreIcon: '🌀',
    durationMin: 112,
    priceRub: 400,
    hue: 275,
    sessions: [],
    ratingAvg: 4.5,
    ratingCount: 2,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  } as Movie;
}

describe('SearchService (unit)', () => {
  let movies: { find: jest.Mock; findOneBy: jest.Mock };

  beforeEach(() => {
    movies = {
      find: jest.fn(async () => [movieRow()]),
      findOneBy: jest.fn(async () => movieRow()),
    };
  });

  describe('onApplicationBootstrap', () => {
    it('без движка (null-стор) — тишина: ни настройки, ни чтения базы', async () => {
      const svc = new SearchService(
        null,
        movies as unknown as Repository<Movie>,
      );
      await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(movies.find).not.toHaveBeenCalled();
    });

    it('настраивает индекс и пересобирает его всем каталогом', async () => {
      const store = makeStore();
      movies.find.mockResolvedValue([movieRow(), movieRow({ id: 'movie-2' })]);
      const svc = new SearchService(store, movies as unknown as Repository<Movie>);

      await svc.onApplicationBootstrap();

      expect(store.ensureIndex).toHaveBeenCalledTimes(1);
      expect(store.rebuild).toHaveBeenCalledTimes(1);
      expect((store.rebuild as jest.Mock).mock.calls[0][0]).toEqual<MovieDoc[]>([
        {
          id: 'movie-1',
          title: 'Рекурсия',
          description: 'петля времени в исходниках',
          genre: 'фантастика',
          genreIcon: '🌀',
          hue: 275,
          ratingAvg: 4.5,
        },
        {
          id: 'movie-2',
          title: 'Рекурсия',
          description: 'петля времени в исходниках',
          genre: 'фантастика',
          genreIcon: '🌀',
          hue: 275,
          ratingAvg: 4.5,
        },
      ]);
    });

    it('упавший движок не роняет бут — поиск уйдёт на фолбэк', async () => {
      const store = makeStore({
        ensureIndex: jest.fn(async () => {
          throw new Error('meili down');
        }),
      });
      const svc = new SearchService(store, movies as unknown as Repository<Movie>);

      await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(store.rebuild).not.toHaveBeenCalled();
    });
  });

  describe('indexMovie', () => {
    const dto: MovieDto = {
      id: 'movie-new',
      title: 'Новый',
      description: 'desc',
      genre: 'тест',
      genreIcon: '🧪',
      durationMin: 100,
      priceRub: 300,
      hue: 10,
      ratingAvg: 0,
      ratingCount: 0,
      sessions: [],
    };

    it('upsert фильма с полями подсказки тем же вызовом', async () => {
      const store = makeStore();
      const svc = new SearchService(store, movies as unknown as Repository<Movie>);

      await svc.indexMovie(dto);

      expect(store.upsert).toHaveBeenCalledWith({
        id: 'movie-new',
        title: 'Новый',
        description: 'desc',
        genre: 'тест',
        genreIcon: '🧪',
        hue: 10,
        ratingAvg: 0,
      });
    });

    it('движок молчит — тихо: создание фильма не отменяется', async () => {
      const store = makeStore({
        upsert: jest.fn(async () => {
          throw new Error('timeout');
        }),
      });
      const svc = new SearchService(store, movies as unknown as Repository<Movie>);

      await expect(svc.indexMovie(dto)).resolves.toBeUndefined();
    });

    it('без движка — no-op', async () => {
      const svc = new SearchService(null, movies as unknown as Repository<Movie>);
      await expect(svc.indexMovie(dto)).resolves.toBeUndefined();
      expect(movies.findOneBy).not.toHaveBeenCalled();
    });
  });

  describe('reindexMovie', () => {
    it('перечитывает фильм из базы и upsert-ит документ', async () => {
      const store = makeStore();
      const svc = new SearchService(store, movies as unknown as Repository<Movie>);

      await svc.reindexMovie('movie-1');

      expect(movies.findOneBy).toHaveBeenCalledWith({ id: 'movie-1' });
      expect(store.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'movie-1', ratingAvg: 4.5 }),
      );
    });

    it('фильм исчез из базы — no-op без upsert', async () => {
      const store = makeStore();
      movies.findOneBy.mockResolvedValue(null);
      const svc = new SearchService(store, movies as unknown as Repository<Movie>);

      await svc.reindexMovie('movie-1');

      expect(store.upsert).not.toHaveBeenCalled();
    });

    it('движок молчит — тихо: отзыв не отменяется', async () => {
      const store = makeStore({
        upsert: jest.fn(async () => {
          throw new Error('boom');
        }),
      });
      const svc = new SearchService(store, movies as unknown as Repository<Movie>);

      await expect(svc.reindexMovie('movie-1')).resolves.toBeUndefined();
    });

    it('без движка — no-op', async () => {
      const svc = new SearchService(null, movies as unknown as Repository<Movie>);
      await expect(svc.reindexMovie('movie-1')).resolves.toBeUndefined();
      expect(movies.findOneBy).not.toHaveBeenCalled();
    });
  });
});

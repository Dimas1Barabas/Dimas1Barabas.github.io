import {
  BadGatewayException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FindOperator } from 'typeorm';
import { ExternalMovie } from './external-movie.entity';
import {
  ExternalMoviesClient,
  ExternalMoviesUnavailableError,
  type ExternalMovieRecord,
} from './external-movies.client';
import { EnrichmentService } from './enrichment.service';
import { Movie } from '../movies/movie.entity';
import { PostersService } from '../posters/posters.service';

const MOVIE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const RECORD: ExternalMovieRecord = {
  title: 'Млечный Путь: Операция «Туманность»',
  year: 2025,
  rating: 8.3,
  votes: 120_450,
  genres: ['фантастика'],
  country: 'Россия',
  director: 'А. Режиссёр',
  actors: ['И. Актёр'],
  ageRating: '16+',
  trailerUrl: 'https://trailers.example/x',
  posterUrl: 'http://kinoapi:8100/posters/x.png',
};

/** Map-репозиторий external_movies с поддержкой In(movieId) из decorate */
function rowsRepo() {
  const rows = new Map<string, ExternalMovie>();
  return {
    rows,
    create: (x: Partial<ExternalMovie>) => x as ExternalMovie,
    save: async (x: ExternalMovie) => {
      rows.set(x.movieId, x);
      return x;
    },
    find: async (opts?: { where?: { movieId?: FindOperator<string> } }) => {
      const wanted = opts?.where?.movieId?.value as string[] | undefined;
      if (!wanted) return [...rows.values()];
      return [...rows.values()].filter((r) => wanted.includes(r.movieId));
    },
    count: async () => rows.size,
  };
}

/** репозиторий каталога: один известный фильм */
function moviesRepo() {
  const movie = {
    id: MOVIE_ID,
    title: RECORD.title,
  } as Movie;
  return {
    findOneByOrFail: async (where: { id: string }) => {
      if (where.id !== movie.id) throw new NotFoundException('Фильм не найден');
      return movie;
    },
  };
}

/** постеры: бакет Map (лекало int-харнесса), флаг enabled управляемый */
function postersFake(withPoster = false) {
  const objects = new Set<string>(withPoster ? [MOVIE_ID] : []);
  return {
    enabled: true,
    poster: jest.fn(async (id: string) =>
      objects.has(id)
        ? { buffer: Buffer.of(1), contentType: 'image/png', etag: '"x"' }
        : null,
    ),
    upload: jest.fn(async (id: string) => {
      objects.add(id);
      return { key: `posters/${id}`, size: 4 };
    }),
  };
}

/** клиент-фейк: помнит вызовы, раздаёт заданные ответы */
function clientFake(
  over: {
    findByTitle?: () => Promise<ExternalMovieRecord | null>;
    fetchPoster?: () => Promise<{ buffer: Buffer; contentType: string } | null>;
  } = {},
) {
  return {
    breaker: { state: 'closed', failureCount: 0 },
    breakerState: 'closed',
    findByTitle: jest.fn(over.findByTitle ?? (async () => null)),
    fetchPoster: jest.fn(
      over.fetchPoster ??
        (async () => ({ buffer: Buffer.from('png-bytes'), contentType: 'image/png' })),
    ),
  };
}

type ClientFake = ReturnType<typeof clientFake>;

function build(client: ClientFake | null, posters = postersFake()) {
  const rows = rowsRepo();
  const movies = moviesRepo();
  const svc = new EnrichmentService(
    client as unknown as ExternalMoviesClient,
    rows as never,
    movies as never,
    posters as unknown as PostersService,
  );
  return { svc, rows, movies, posters, client };
}

describe('EnrichmentService.syncMovie', () => {
  it('справочник знает фильм — upsert строки и постер в S3', async () => {
    const { svc, rows, posters } = build(clientFake({ findByTitle: async () => RECORD }));
    const res = await svc.syncMovie(MOVIE_ID);
    expect(res.matched).toBe(true);
    expect(res.posterSynced).toBe(true);
    expect(rows.rows.get(MOVIE_ID)).toMatchObject({
      rating: 8.3,
      sourcePosterUrl: RECORD.posterUrl,
    });
    expect(res.external).toMatchObject({ rating: 8.3, year: 2025 });
    expect(posters.upload).toHaveBeenCalledWith(
      MOVIE_ID,
      Buffer.from('png-bytes'),
      'image/png',
    );
  });

  it('свой постер админа не перетирает: не качаем и не заливаем', async () => {
    const client = clientFake({ findByTitle: async () => RECORD });
    const posters = postersFake(true); // постер уже есть
    const { svc } = build(client, posters);
    const res = await svc.syncMovie(MOVIE_ID);
    expect(res.matched).toBe(true);
    expect(res.posterSynced).toBe(false);
    expect(client.fetchPoster).not.toHaveBeenCalled();
    expect(posters.upload).not.toHaveBeenCalled();
  });

  it('постер не скачался — синк всё равно успешный', async () => {
    const client = clientFake({
      findByTitle: async () => RECORD,
      fetchPoster: async () => null,
    });
    const { svc, rows, posters } = build(client);
    const res = await svc.syncMovie(MOVIE_ID);
    expect(res.matched).toBe(true);
    expect(res.posterSynced).toBe(false);
    expect(rows.rows.size).toBe(1); // строка записана
    expect(posters.upload).not.toHaveBeenCalled();
  });

  it('повторный синк обновляет строку, а не плодит', async () => {
    const { svc, rows } = build(clientFake({ findByTitle: async () => RECORD }));
    await svc.syncMovie(MOVIE_ID);
    await svc.syncMovie(MOVIE_ID);
    expect(rows.rows.size).toBe(1);
  });

  it('справочник не знает фильм — matched:false без записи', async () => {
    const { svc, rows } = build(clientFake()); // findByTitle -> null
    const res = await svc.syncMovie(MOVIE_ID);
    expect(res).toMatchObject({ matched: false, reason: 'not_found' });
    expect(rows.rows.size).toBe(0);
  });

  it('справочник недоступен — 502, строка не пишется', async () => {
    const client = clientFake();
    client.findByTitle.mockImplementation(async () => {
      throw new ExternalMoviesUnavailableError('breaker открыт (3 неудач подряд)');
    });
    const { svc, rows } = build(client);
    await expect(svc.syncMovie(MOVIE_ID)).rejects.toBeInstanceOf(BadGatewayException);
    expect(rows.rows.size).toBe(0);
  });

  it('модуль выключен — 503', async () => {
    const { svc } = build(null);
    await expect(svc.syncMovie(MOVIE_ID)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('фильма нет — 404 ДО похода в справочник', async () => {
    const { svc, client } = build(clientFake({ findByTitle: async () => RECORD }));
    await expect(svc.syncMovie(OTHER_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(client!.findByTitle).not.toHaveBeenCalled();
  });
});

describe('EnrichmentService.decorate', () => {
  it('приклеивает external тем, у кого строка есть', async () => {
    const { svc } = build(clientFake({ findByTitle: async () => RECORD }));
    await svc.syncMovie(MOVIE_ID);
    const out = await svc.decorate([
      { id: MOVIE_ID, title: 'A' },
      { id: OTHER_ID, title: 'B' },
    ]);
    expect(out[0].external).toMatchObject({ rating: 8.3 });
    expect(out[1].external).toBeUndefined();
  });

  it('пустой каталог — без похода в БД', async () => {
    const { svc, rows } = build(clientFake());
    const spy = jest.spyOn(rows, 'find');
    expect(await svc.decorate([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('БД молчит — карточки как были (деградация, не 500)', async () => {
    const { svc, rows } = build(clientFake());
    const spy = jest.spyOn(rows, 'find').mockRejectedValueOnce(new Error('pg is down'));
    const dtos = [{ id: MOVIE_ID, title: 'A' }];
    await expect(svc.decorate(dtos)).resolves.toEqual(dtos);
    expect(spy).toHaveBeenCalled();
  });
});

describe('EnrichmentService.status', () => {
  it('выключенный модуль: enabled=false, breaker off', async () => {
    const { svc } = build(null);
    expect(await svc.status()).toMatchObject({
      enabled: false,
      breaker: { state: 'off', failures: 0 },
      enrichedMovies: 0,
    });
  });

  it('включённый: состояние цепи и счёт строк', async () => {
    const { svc } = build(clientFake({ findByTitle: async () => RECORD }));
    await svc.syncMovie(MOVIE_ID);
    expect(await svc.status()).toMatchObject({
      enabled: true,
      breaker: { state: 'closed', failures: 0 },
      enrichedMovies: 1,
    });
  });

  it('count молчит — enrichedMovies:null, витрина не падает', async () => {
    const { svc, rows } = build(clientFake());
    jest.spyOn(rows, 'count').mockRejectedValueOnce(new Error('pg is down'));
    expect(await svc.status()).toMatchObject({ enrichedMovies: null });
  });
});

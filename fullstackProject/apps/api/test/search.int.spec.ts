/**
 * HTTP-int уровень поиска (этап 30): реальный роутинг + ValidationPipe +
 * SearchController → SearchService, фейковые репозиторий и стор
 * Meilisearch. Оба контракта источника: живой движок и ILIKE-фолбэк
 * (движка нет / молчит) — витрина поиск не теряет никогда.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { Movie } from '../src/movies/movie.entity';
import { MeiliStore, MovieDoc } from '../src/search/meili.store';
import { SearchController } from '../src/search/search.controller';
import { SearchService } from '../src/search/search.service';

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

/** фейковый стор: поиск возвращает подсказки или бросается */
function makeStore(search: jest.Mock) {
  return { search } as unknown as MeiliStore;
}

/** фейковый репозиторий для ILIKE-фолбэка: цепочка query-builder'а */
function makeRepo(rows: Movie[]) {
  const getMany = jest.fn(async () => rows);
  const builder = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany,
  };
  return {
    find: jest.fn(async () => rows),
    findOneBy: jest.fn(async () => rows[0] ?? null),
    createQueryBuilder: jest.fn(() => builder),
  };
}

describe('GET /api/search/movies (int)', () => {
  /**
   * Приложение с подменным стором. store=null — режим «движка нет»,
   * jest.Mock — режимы «живой» / «молчит».
   */
  async function buildApp(store: MeiliStore | null, rows: Movie[]) {
    const moduleRef = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [
        SearchService,
        { provide: MeiliStore, useValue: store },
        { provide: getRepositoryToken(Movie), useValue: makeRepo(rows) },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    return app;
  }

  it('живой движок: подсказки из Meilisearch, источник meilisearch', async () => {
    const docs: MovieDoc[] = [
      {
        id: 'movie-1',
        title: 'Рекурсия',
        description: 'петля времени',
        genre: 'фантастика',
        genreIcon: '🌀',
        hue: 275,
        ratingAvg: 4.5,
      },
    ];
    const search = jest.fn(async () => docs);
    const app = await buildApp(makeStore(search), [movieRow()]);

    const res = await request(app.getHttpServer()).get(
      '/api/search/movies?q=рекурс&limit=5',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: 'meilisearch',
      data: [
        {
          id: 'movie-1',
          title: 'Рекурсия',
          genre: 'фантастика',
          genreIcon: '🌀',
          hue: 275,
          ratingAvg: 4.5,
        },
      ],
    });
    expect(search).toHaveBeenCalledWith('рекурс', 5);
    await app.close();
  });

  it('движок молчит — фолбэк: источник db, подсказки из базы', async () => {
    const search = jest.fn(async () => {
      throw new Error('meili down');
    });
    const app = await buildApp(makeStore(search), [movieRow()]);

    const res = await request(app.getHttpServer()).get('/api/search/movies?q=время');

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('db');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ title: 'Рекурсия', ratingAvg: 4.5 });
    await app.close();
  });

  it('движка нет (null-стор) — сразу фолбэк, поиск жив', async () => {
    const app = await buildApp(null, [movieRow()]);

    const res = await request(app.getHttpServer()).get('/api/search/movies?q=петля');

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('db');
    expect(res.body.data).toHaveLength(1);
    await app.close();
  });

  it('пустой после трима запрос — пустые подсказки без похода в движок', async () => {
    const search = jest.fn(async () => []);
    const app = await buildApp(makeStore(search), []);

    const res = await request(app.getHttpServer())
      .get('/api/search/movies')
      .query({ q: '   ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ source: 'meilisearch', data: [] });
    expect(search).not.toHaveBeenCalled();
    await app.close();
  });

  it('нет q — 400; limit вне 1..20 — 400', async () => {
    const app = await buildApp(null, []);

    expect(
      (await request(app.getHttpServer()).get('/api/search/movies')).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer()).get('/api/search/movies?q=а&limit=21')
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app.getHttpServer()).get('/api/search/movies?q=а&limit=0')
      ).status,
    ).toBe(400);
    await app.close();
  });

  it('публичен: без токена отвечает 200', async () => {
    const app = await buildApp(null, []);

    const res = await request(app.getHttpServer()).get('/api/search/movies?q=а');

    expect(res.status).toBe(200);
    await app.close();
  });
});

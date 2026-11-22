/**
 * Live-int уровень внешних метаданных (этап 37): приложение целиком против
 * testcontainers (PG + Redis + Rabbit + SeaweedFS) и ЛОКАЛЬНОГО HTTP-мока
 * справочника — node:http в этом же процессе, контракт мок-контейнера
 * kinoapi. Проверяется то, чего не видно на фейках: настоящий SQL-upsert
 * строки external_movies, настоящий S3-путь постера (мок → API → SeaweedFS),
 * breaker на живых таймерах (кураженные маленькими env), декорирование
 * каталога поверх живого Redis-кэша.
 *
 * env гейта выставляются ДО buildLiveApp: EnrichmentModule читает их на
 * сборке DI (как S3_ENDPOINT/MEILI_HOST); в afterAll снимаем — файлы,
 * идущие за нами в --runInBand-процессе, компилируются без нашего мока.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { buildLiveApp, describeLive } from './live-harness';
import type { LiveAppContext } from './live-harness';

jest.setTimeout(60_000);

/** 1×1 PNG — валидные байты для S3-пути постера */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MILKY_RECORD = {
  title: 'Млечный Путь: Операция «Туманность»',
  year: 2025,
  rating: 8.3,
  votes: 120450,
  genres: ['фантастика', 'драма'],
  country: 'Россия',
  director: 'А. Режиссёр',
  actors: ['И. Актёр'],
  ageRating: '16+',
  trailerUrl: 'https://trailers.example/milky-way-nebula',
  posterUrl: '', // подставим адрес мока после старта
};

/** мок справочника: поиск + постер + chaos-режим + счётчик поисков */
function startMock() {
  const state = { mode: 'ok', searchHits: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const json = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload);
    };
    if (req.method === 'POST' && url.pathname === '/__chaos') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.mode = (JSON.parse(body || '{}').mode as string) ?? 'ok';
        json(200, { mode: state.mode });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/__stats') {
      return json(200, state);
    }
    if (state.mode === '500') return json(500, { error: 'internal' });
    if (req.method === 'GET' && url.pathname === '/v1/movies/search') {
      state.searchHits += 1;
      const q = url.searchParams.get('title') ?? '';
      const items = q.includes('Млечный')
        ? [{ ...MILKY_RECORD, posterUrl: `${mockUrl}/posters/milky-way-nebula` }]
        : [];
      return json(200, { items });
    }
    if (req.method === 'GET' && url.pathname === '/posters/milky-way-nebula') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(TINY_PNG);
    }
    json(404, { error: 'нет маршрута' });
  });
  let mockUrl = ''; // замыкание заполняется после listen
  return new Promise<{ url: string; state: typeof state; close: () => void }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        mockUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve({
          url: mockUrl,
          state,
          close: () => server.close(),
        });
      });
    },
  );
}

describeLive('внешние метаданные афиши (live: PG+Redis+SeaweedFS+мок-справочник)', () => {
  let ctx: LiveAppContext;
  let mock: Awaited<ReturnType<typeof startMock>>;
  let milkyId: string;
  let adminBearer: string;

  beforeAll(async () => {
    mock = await startMock();
    // ДО сборки DI: гейт и быстрые числа для breaker-сценария
    process.env.EXTERNAL_MOVIES_URL = mock.url;
    process.env.EXTERNAL_MOVIES_RETRIES = '0'; // одна попытка — падение сразу
    process.env.EXTERNAL_MOVIES_TIMEOUT_MS = '2000';
    process.env.EXTERNAL_MOVIES_BREAKER_THRESHOLD = '2';
    process.env.EXTERNAL_MOVIES_BREAKER_COOLDOWN_MS = '1500';
    ctx = await buildLiveApp();
    adminBearer = ctx.bearerAdmin;
    const movies = await ctx.catalog();
    milkyId = movies.find((m) => m.title.includes('Млечный'))!.id;
  });

  afterAll(async () => {
    await ctx.stopOutboxRelay();
    await ctx.app.close();
    mock.close();
    // следующий live-файл компилирует AppModule без нашего мока
    delete process.env.EXTERNAL_MOVIES_URL;
    delete process.env.EXTERNAL_MOVIES_RETRIES;
    delete process.env.EXTERNAL_MOVIES_TIMEOUT_MS;
    delete process.env.EXTERNAL_MOVIES_BREAKER_THRESHOLD;
    delete process.env.EXTERNAL_MOVIES_BREAKER_COOLDOWN_MS;
  });

  const sync = (id: string) =>
    request(ctx.app.getHttpServer())
      .post(`/api/movies/${id}/external-sync`)
      .set('Authorization', adminBearer);

  it('синк: строка в PG, external в каталоге, постер мока доехал до SeaweedFS', async () => {
    const res = await sync(milkyId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matched: true, posterSynced: true });
    expect(res.body.external).toMatchObject({ rating: 8.3, year: 2025 });

    // строка в таблице — настоящим SQL
    const rows: { rating: number; genre_csv: string }[] = await ctx.db.query(
      'SELECT rating, genres AS genre_csv FROM external_movies WHERE movie_id = $1',
      [milkyId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].rating)).toBeCloseTo(8.3);

    // каталог несёт внешний блок
    const cat = await request(ctx.app.getHttpServer()).get('/api/movies');
    const withExternal = cat.body.data.find((m: { id: string }) => m.id === milkyId);
    expect(withExternal.external).toMatchObject({
      rating: 8.3,
      director: 'А. Режиссёр',
      trailerUrl: 'https://trailers.example/milky-way-nebula',
    });

    // постер: байты мока лежат в S3 и раздаются витриной
    const poster = await request(ctx.app.getHttpServer()).get(
      `/api/movies/${milkyId}/poster`,
    );
    expect(poster.status).toBe(200);
    expect(poster.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(poster.body, TINY_PNG)).toBe(0);
  });

  it('свой постер админа синк не перетирает', async () => {
    const own = Buffer.from('own-poster-bytes');
    const up = await request(ctx.app.getHttpServer())
      .post(`/api/movies/${milkyId}/poster`)
      .set('Authorization', adminBearer)
      .attach('poster', own, { filename: 'own.png', contentType: 'image/png' });
    expect(up.status).toBe(200);

    const res = await sync(milkyId);
    expect(res.body).toMatchObject({ matched: true, posterSynced: false });

    const poster = await request(ctx.app.getHttpServer()).get(
      `/api/movies/${milkyId}/poster`,
    );
    expect(Buffer.compare(poster.body, own)).toBe(0);
  });

  it('breaker: 502 при недоступности, открытие без походов в сеть, полупроба лечит', async () => {
    await fetch(`${mock.url}/__chaos`, {
      method: 'POST',
      body: JSON.stringify({ mode: '500' }),
      headers: { 'Content-Type': 'application/json' },
    });

    // две неудачи (порог 2, ретраев нет) — цепь открыта
    const first = await sync(milkyId);
    expect(first.status).toBe(502);
    const second = await sync(milkyId);
    expect(second.status).toBe(502);

    // открытая цепь: 502 мгновенно, БЕЗ новых запросов к справочнику
    const hitsBefore = mock.state.searchHits;
    const third = await sync(milkyId);
    expect(third.status).toBe(502);
    expect(third.body.message).toMatch(/breaker/);
    expect(mock.state.searchHits).toBe(hitsBefore); // вверх не ходили!

    const status = await request(ctx.app.getHttpServer())
      .get('/api/admin/external-movies/status')
      .set('Authorization', adminBearer);
    expect(status.body.breaker).toMatchObject({ state: 'open', failures: 2 });

    // каталог при открытом breaker не задет: карточки как были
    const cat = await request(ctx.app.getHttpServer()).get('/api/movies');
    expect(cat.status).toBe(200);
    expect(cat.body.data.length).toBeGreaterThan(0);

    // кулдаун 1.5 c прошёл — полупроба успешна, цепь закрыта
    await fetch(`${mock.url}/__chaos`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'ok' }),
      headers: { 'Content-Type': 'application/json' },
    });
    await new Promise((r) => setTimeout(r, 1600));
    const healed = await sync(milkyId);
    expect(healed.status).toBe(200);
    expect(healed.body.matched).toBe(true);

    const after = await request(ctx.app.getHttpServer())
      .get('/api/admin/external-movies/status')
      .set('Authorization', adminBearer);
    expect(after.body.breaker).toMatchObject({ state: 'closed', failures: 0 });
  });

  it('справочник не знает фильм — matched:false без строки', async () => {
    const created = await request(ctx.app.getHttpServer())
      .post('/api/movies')
      .set('Authorization', adminBearer)
      .send({
        title: 'Кино, которого нет в справочнике',
        description: 'создано спекой',
        genre: 'драма',
        genreIcon: '🎭',
        durationMin: 90,
        priceRub: 300,
        hue: 20,
        sessions: [
          { hall: 'Красный', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
        ],
      });
    expect(created.status).toBe(201);

    const res = await sync(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matched: false, reason: 'not_found' });

    const count: { n: string }[] = await ctx.db.query(
      'SELECT count(*)::text AS n FROM external_movies WHERE movie_id = $1',
      [created.body.id],
    );
    expect(Number(count[0].n)).toBe(0);
  });
});

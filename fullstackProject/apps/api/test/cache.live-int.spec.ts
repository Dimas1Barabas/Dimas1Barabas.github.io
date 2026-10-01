/**
 * Кэш каталога против живого Redis (testcontainers): withCache кладёт
 * ключи с настоящим TTL, инвалидация на админской мутации стирает их
 * по-настоящему. На Map-фейке int-спеков это поведение эмулировалось —
 * здесь сверяем байты в реальном хранилище.
 */
import Redis from 'ioredis';
import request from 'supertest';
import { MOVIES_KEY, movieKey } from '../src/movies/movies.service';
import { describeLive, buildLiveApp, liveInfra, type LiveAppContext } from './live-harness';

describeLive('CineBooking API: кэш каталога в живом Redis (testcontainers)', () => {
  let h: LiveAppContext;
  let redis: Redis;

  beforeAll(async () => {
    h = await buildLiveApp();
    redis = new Redis((await liveInfra()).redisUrl);
  }, 240_000);

  afterAll(async () => {
    redis?.disconnect();
    await h?.app.close();
  });

  const movies = () => request(h.app.getHttpServer()).get('/api/movies');

  it('первое чтение — из БД, второе — из Redis: ключ живёт с TTL', async () => {
    const first = await movies();
    expect(first.status).toBe(200);
    expect(first.body.source).toBe('db');

    const second = await movies();
    expect(second.body.source).toBe('cache');
    expect(second.body.data.map((m: { id: string }) => m.id)).toEqual(
      first.body.data.map((m: { id: string }) => m.id),
    );

    // ключ реально в Redis и тикает: TTL в пределах исходных 60 секунд
    const ttl = await redis.ttl(MOVIES_KEY);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // кэш — честный JSON каталога
    const raw = await redis.get(MOVIES_KEY);
    expect(Array.isArray(JSON.parse(raw!))).toBe(true);
  });

  it('карточка фильма кэшируется своим ключом movie:v3:<id>', async () => {
    const list = await movies();
    const movie = list.body.data[0];

    const first = await request(h.app.getHttpServer()).get(`/api/movies/${movie.id}`);
    expect(first.status).toBe(200);

    const cached = await redis.get(movieKey(movie.id));
    expect(cached).toBeTruthy();
    expect(JSON.parse(cached!).id).toBe(movie.id);
  });

  it('админская мутация инвалидирует кэш списка: следующий GET — из БД с новым фильмом', async () => {
    // прогрев
    await movies();
    expect(await redis.exists(MOVIES_KEY)).toBe(1);

    const created = await request(h.app.getHttpServer())
      .post('/api/movies')
      .set('Authorization', h.bearerAdmin)
      .send({
        title: 'Живой тест',
        description: 'Фильм, созданный live-int спеком',
        genre: 'драма',
        genreIcon: '🎭',
        durationMin: 100,
        priceRub: 450,
        hue: 200,
        sessions: [{ hall: 'Красный', startsAt: '2026-12-01T19:00:00.000Z' }],
      });
    expect(created.status).toBe(201);

    // MoviesService.create сбрасывает кэш — ключа больше нет
    expect(await redis.exists(MOVIES_KEY)).toBe(0);

    const after = await movies();
    expect(after.body.source).toBe('db');
    expect(after.body.data.map((m: { id: string }) => m.id)).toContain(created.body.id);
  });
});

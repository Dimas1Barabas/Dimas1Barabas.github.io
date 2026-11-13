/**
 * Поиск афиши (этап 30) против живого Meilisearch: тот же образ и
 * production-режим с мастер-ключом, что в compose-стенде. Здесь
 * проверяется настоящий REST-путь, недоступный фейку int-спеков:
 * бут-индексация каталога, полнотекстовый поиск с префиксом последнего
 * слова и опечатками, лимит подсказок, хук create → документ в индексе
 * тем же запросом. Гейт describeLive: живой прогон делает CI-робот,
 * локально спека скипается.
 */
import request from 'supertest';
import { describeLive, buildLiveApp, type LiveAppContext } from './live-harness';

// Первая индексация на свежем Meilisearch холодная (создание индекса +
// задачи), дефолтных 5 c может не хватить — норма live-спеков
// (урок постеров: холодный первый S3-put)
jest.setTimeout(30_000);

describeLive('CineBooking API: поиск на живом Meilisearch (testcontainers)', () => {
  let h: LiveAppContext;

  beforeAll(async () => {
    h = await buildLiveApp();
  }, 240_000);

  afterAll(async () => {
    await h?.stopOutboxRelay();
    await h?.app.close();
  });

  it('бут проиндексировал каталог: поиск по слову названия через движок', async () => {
    const res = await request(h.app.getHttpServer()).get(
      '/api/search/movies?q=рекурс',
    );

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('meilisearch');
    expect(res.body.data.length).toBeGreaterThan(0);
    // посев знает «Рекурсию»; последняя словоформа запроса — префикс
    expect(res.body.data[0].title).toBe('Рекурсия');
  });

  it('подсказка несёт поля витрины: жанр, иконку, оттенок, рейтинг', async () => {
    const res = await request(h.app.getHttpServer()).get(
      '/api/search/movies?q=Рекурсия',
    );

    expect(res.body.data[0]).toMatchObject({
      id: expect.any(String),
      title: 'Рекурсия',
      genre: expect.any(String),
      genreIcon: expect.any(String),
      hue: expect.any(Number),
      ratingAvg: expect.any(Number),
    });
    // описание в подсказку не ездит — только поля витрины
    expect(res.body.data[0].description).toBeUndefined();
  });

  it('терпит опечатку: «Рекусия» находит «Рекурсию»', async () => {
    const res = await request(h.app.getHttpServer()).get(
      '/api/search/movies?q=Рекусия',
    );

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('meilisearch');
    expect(res.body.data.some((m: { title: string }) => m.title === 'Рекурсия')).toBe(
      true,
    );
  });

  it('limit режет выдачу', async () => {
    const res = await request(h.app.getHttpServer()).get(
      '/api/search/movies?q=а&limit=2',
    );

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });

  it('нет совпадений — пустой список, источник всё ещё движок', async () => {
    const res = await request(h.app.getHttpServer()).get(
      '/api/search/movies?q=зелёныйслониквкосмосе',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ source: 'meilisearch', data: [] });
  });

  it('фильм из POST /api/movies появляется в подсказках тем же циклом (хук create)', async () => {
    const created = await request(h.app.getHttpServer())
      .post('/api/movies')
      .set('Authorization', h.bearerAdmin)
      .send({
        title: 'Тестовый поискун',
        description: 'спец-фильм живой проверки индексации',
        genre: 'поиск',
        genreIcon: '🔎',
        durationMin: 90,
        priceRub: 350,
        hue: 120,
        sessions: [{ hall: 'IMAX', startsAt: '2026-12-31T21:00:00.000Z' }],
      });

    expect(created.status).toBe(201);

    const res = await request(h.app.getHttpServer()).get(
      '/api/search/movies?q=поискун',
    );

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('meilisearch');
    expect(res.body.data[0]).toMatchObject({ title: 'Тестовый поискун' });
  });
});

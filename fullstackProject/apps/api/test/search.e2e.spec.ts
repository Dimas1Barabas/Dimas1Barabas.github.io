/**
 * E2E поиск афиши (этап 30): Meilisearch сквозь весь стенд — от браузерного
 * запроса до индекса. e2e-compose поднимает meilisearch явно, так что здесь
 * проверяется живой движок: бут-индексация при старте api, поиск с опечаткой,
 * хук create. Без стенда файл тихо скипается (см. e2e-context).
 */
import { adminToken, api, bootstrap, available } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('поиск афиши: Meilisearch сквозь весь стенд', () => {
  it('поиск по слову названия — подсказки от движка', async () => {
    if (!available) return;
    const res = await api<{ source: string; data: { title: string }[] }>(
      '/search/movies?q=рекурс',
    );

    expect(res.source).toBe('meilisearch');
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data[0].title).toBe('Рекурсия');
  });

  it('опечатка в запросе находит фильм', async () => {
    if (!available) return;
    const res = await api<{ data: { title: string }[] }>(
      '/search/movies?q=Рекусия',
    );

    expect(res.data.some((m) => m.title === 'Рекурсия')).toBe(true);
  });

  it('подсказка — карточка витрины: жанр/иконка/оттенок/рейтинг, без описания', async () => {
    if (!available) return;
    const res = await api<{
      data: {
        id: string;
        title: string;
        genre: string;
        genreIcon: string;
        hue: number;
        ratingAvg: number;
        description?: string;
      }[];
    }>('/search/movies?q=Рекурсия');

    expect(res.data[0]).toMatchObject({
      id: expect.any(String),
      title: 'Рекурсия',
      genre: expect.any(String),
      genreIcon: expect.any(String),
      hue: expect.any(Number),
      ratingAvg: expect.any(Number),
    });
    expect(res.data[0].description).toBeUndefined();
  });

  it('нет совпадений — пустой список, не ошибка', async () => {
    if (!available) return;
    const res = await api<{ source: string; data: unknown[] }>(
      '/search/movies?q=зелёныйслониквкосмосе',
    );

    expect(res.source).toBe('meilisearch');
    expect(res.data).toEqual([]);
  });

  it('новый фильм от админа появляется в подсказках тем же циклом', async () => {
    if (!available) return;
    const admin = await adminToken();
    const unique = `E2E Поискун ${Date.now()}`;
    await api('/movies', {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}` },
      body: JSON.stringify({
        title: unique,
        description: 'Фильм для сквозной проверки индексации поиска',
        genre: 'e2e',
        genreIcon: '🔎',
        durationMin: 75,
        priceRub: 350,
        hue: 120,
        sessions: [{ hall: 'IMAX', startsAt: '2026-12-31T21:00:00.000Z' }],
      }),
    });

    const res = await api<{ data: { title: string }[] }>(
      `/search/movies?q=${encodeURIComponent('Поискун')}`,
    );

    expect(res.data.some((m) => m.title === unique)).toBe(true);
  });
});

/**
 * Демо-движок: поиск афиши (этап 30) — зеркало suggest API: подстрока
 * без учёта регистра по названию/описанию/жанру, лимит, сортировка по
 * рейтингу, поля карточки-миниатюры без описания. Гостевая Pages-демка
 * ищет тот же каталог, что и живой стенд.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';

describe('demoEngine: поиск афиши', () => {
  beforeEach(() => {
    demoEngine.reset();
  });

  it('подстрока названия находит фильм, регистр не важен', () => {
    const res = demoEngine.searchMovies('РЕКУРС');

    expect(res.source).toBe('meilisearch');
    expect(res.data.some((s) => s.title === 'Рекурсия')).toBe(true);
  });

  it('ищет и по описанию, и по жанру', () => {
    expect(demoEngine.searchMovies('Туманность').data.length).toBeGreaterThan(0);
    expect(
      demoEngine.searchMovies('фантастика').data.some((s) => s.genre === 'фантастика'),
    ).toBe(true);
  });

  it('подсказка — карточка витрины: без описания, с чипом и рейтингом', () => {
    const [first] = demoEngine.searchMovies('дебаг').data;

    expect(first).toMatchObject({
      id: 'demo-last-debug',
      title: 'Последний дебаг',
      genre: 'триллер',
      genreIcon: '🐞',
      hue: 160,
      ratingAvg: expect.any(Number),
    });
    expect(Object.keys(first)).not.toContain('description');
  });

  it('лимит режет выдачу', () => {
    expect(demoEngine.searchMovies('а', 2).data.length).toBeLessThanOrEqual(2);
  });

  it('пустой после трима запрос — пустые подсказки', () => {
    expect(demoEngine.searchMovies('   ')).toEqual({
      source: 'meilisearch',
      data: [],
    });
  });

  it('нет совпадений — пустой список, не ошибка', () => {
    expect(demoEngine.searchMovies('зелёныйслониквкосмосе').data).toEqual([]);
  });

  it('выдача отсортирована по рейтингу сверху', () => {
    const res = demoEngine.searchMovies('а', 20);
    const ratings = res.data.map((s) => s.ratingAvg);

    expect([...ratings].sort((a, b) => b - a)).toEqual(ratings);
  });
});

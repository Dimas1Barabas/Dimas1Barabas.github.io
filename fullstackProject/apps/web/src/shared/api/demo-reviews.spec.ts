/**
 * Демо-движок: отзывы — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { CLEAN_MOVIE, freeSeat } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: отзывы', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function confirmBooking(movieId: string): Promise<void> {
    const movie = demoEngine.movies().data.find((m) => m.id === movieId);
    if (!movie) throw new Error('нет фильма');
    const session = movie.sessions[0];
    if (!session) throw new Error('нет сеансов');
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const created = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: [seat],
    });
    demoEngine.pay(created.id);
    await vi.advanceTimersByTimeAsync(3000);
    randomSpy.mockRestore();
    expect(demoEngine.canReview(movieId)).toBe(true);
  }


  it('отзывы: сиды на месте, агрегаты фильмов совпадают с ними', () => {
    const seeded = demoEngine.reviewsOf('demo-milky-way');
    expect(seeded).toHaveLength(2);
    // свежие сверху: у Игоря daysAgo 1, у Ольги 3
    expect(seeded[0].authorName).toBe('Игорь');
    expect(seeded.every((r) => r.userId.startsWith('demo-seed-'))).toBe(true);

    const movies = demoEngine.movies().data;
    const milky = movies.find((m) => m.id === 'demo-milky-way');
    expect(milky).toMatchObject({ ratingAvg: 4.5, ratingCount: 2 });
    const clean = movies.find((m) => m.id === CLEAN_MOVIE);
    expect(clean).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
    // у фильма без отзывов список пуст
    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toEqual([]);
  });

  it('movies() отдаёт копии: старая выдача не видит новый рейтинг', async () => {
    const before = demoEngine.movies().data;
    await confirmBooking(CLEAN_MOVIE);
    demoEngine.createReview(CLEAN_MOVIE, {
      rating: 5,
      text: 'Драма держит в напряжении до титров!',
    });

    // старые объекты — прежний рейтинг (как JSON, ушедший по проводу)
    expect(before.find((m) => m.id === CLEAN_MOVIE)?.ratingCount).toBe(0);
    // новая выдача — свежий агрегат
    const after = demoEngine.movies().data;
    expect(after.find((m) => m.id === CLEAN_MOVIE)).toMatchObject({
      ratingAvg: 5,
      ratingCount: 1,
    });
  });

  it('createReview: без подтверждённой брони — 403 с пояснением', () => {
    expect(() =>
      demoEngine.createReview(CLEAN_MOVIE, { rating: 5, text: 'Хочу отзыв без брони!' }),
    ).toThrow(ApiError);
    try {
      demoEngine.createReview(CLEAN_MOVIE, { rating: 5, text: 'Хочу отзыв без брони!' });
    } catch (e) {
      expect((e as ApiError).status).toBe(403);
      expect(JSON.parse((e as ApiError).body).message).toContain('бронь');
    }
  });

  it('createReview: после брони — создаётся, агрегат растёт, подписчик оповещён', async () => {
    await confirmBooking(CLEAN_MOVIE);
    const cb = vi.fn();
    demoEngine.onChange(cb);

    const review = demoEngine.createReview(CLEAN_MOVIE, {
      rating: 4,
      text: '  Игра актрисы выше всяких похвал.  ',
    });

    expect(review).toMatchObject({
      movieId: CLEAN_MOVIE,
      authorName: 'Гость',
      rating: 4,
      text: 'Игра актрисы выше всяких похвал.',
    });
    expect(demoEngine.reviewsOf(CLEAN_MOVIE)[0].id).toBe(review.id);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE)).toMatchObject(
      { ratingAvg: 4, ratingCount: 1 },
    );
  });

  it('createReview: дубль гостя — 409 reviewExists', async () => {
    await confirmBooking(CLEAN_MOVIE);
    demoEngine.createReview(CLEAN_MOVIE, {
      rating: 5,
      text: 'Первый отзыв уже написан.',
    });

    try {
      demoEngine.createReview(CLEAN_MOVIE, {
        rating: 3,
        text: 'Передумал, теперь три звезды.',
      });
      expect.unreachable('дубль должен был упасть 409');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(409);
      expect(JSON.parse((e as ApiError).body).code).toBe('reviewExists');
    }
    // агрегат не задвоился
    expect(
      demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE)?.ratingCount,
    ).toBe(1);
  });

  it('createReview: валидация — 400 на оценку и короткий текст', async () => {
    await confirmBooking(CLEAN_MOVIE);
    expect(() =>
      demoEngine.createReview(CLEAN_MOVIE, { rating: 6, text: 'Валидный текст отзыва.' }),
    ).toThrow(ApiError);
    try {
      demoEngine.createReview(CLEAN_MOVIE, { rating: 6, text: 'Валидный текст отзыва.' });
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
    }
    expect(() =>
      demoEngine.createReview(CLEAN_MOVIE, { rating: 5, text: 'коротко' }),
    ).toThrow(ApiError);
  });

  it('deleteReview: пересчитывает агрегат и оповещает', async () => {
    await confirmBooking(CLEAN_MOVIE);
    const review = demoEngine.createReview(CLEAN_MOVIE, {
      rating: 2,
      text: 'Не зашло, но это дело вкуса.',
    });
    const cb = vi.fn();
    demoEngine.onChange(cb);

    demoEngine.deleteReview(CLEAN_MOVIE, review.id);

    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toEqual([]);
    expect(
      demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE),
    ).toMatchObject({ ratingAvg: 0, ratingCount: 0 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(() => demoEngine.deleteReview(CLEAN_MOVIE, review.id)).toThrow();
  });

  it('reset восстанавливает сид-отзывы и агрегаты', async () => {
    await confirmBooking(CLEAN_MOVIE);
    demoEngine.createReview(CLEAN_MOVIE, {
      rating: 5,
      text: 'След исчезает после сброса.',
    });
    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toHaveLength(1);

    demoEngine.reset();

    expect(demoEngine.reviewsOf(CLEAN_MOVIE)).toEqual([]);
    expect(demoEngine.canReview(CLEAN_MOVIE)).toBe(false);
    expect(
      demoEngine.movies().data.find((m) => m.id === CLEAN_MOVIE)?.ratingCount,
    ).toBe(0);
    expect(demoEngine.reviewsOf('demo-milky-way')).toHaveLength(2);
  });

  // ── Админ-аналитика ─────────────────────────────────────────────────

});

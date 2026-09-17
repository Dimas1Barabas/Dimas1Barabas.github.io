import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { Review, SeatMap } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useMoviesStore } from '@/entities/movie/model/movies.store';
import { useReviewsStore } from '@/entities/movie/model/reviews.store';

vi.mock('@/shared/api/client', async (importOriginal) => {
  // ApiError и localStorage-хелперы оставляем настоящими; мокаем только сеть
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      movies: vi.fn(),
      movieReviews: vi.fn(),
      createReview: vi.fn(),
      deleteReview: vi.fn(),
    },
  };
});

/** первое свободное место карты — чтобы тест не зависел от посева */
function freeSeatOf(map: SeatMap): string {
  for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) return code;
    }
  }
  throw new Error('зал заполнен');
}

/** подтверждённая демо-бронь на «чистый» фильм (без сид-отзывов) */
async function confirmDemoBooking(): Promise<void> {
  const movie = demoEngine.movies().data.find((m) => m.id === 'demo-cache-lady');
  if (!movie) throw new Error('нет фильма');
  const session = movie.sessions[0];
  if (!session) throw new Error('нет сеансов');
  const seat = freeSeatOf(demoEngine.seatMap(session.id));
  const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
  const created = demoEngine.create({
    sessionId: session.id,
    customerName: 'Тест',
    seats: [seat],
  });
  demoEngine.pay(created.id);
  await vi.advanceTimersByTimeAsync(3000);
  randomSpy.mockRestore();
}

const review: Review = {
  id: 'r-1',
  movieId: 'm-1',
  userId: 'u-1',
  authorName: 'Анна',
  rating: 4,
  text: 'Хороший фильм, советую.',
  createdAt: '2026-09-10T10:00:00.000Z',
  updatedAt: '2026-09-10T10:00:00.000Z',
};

describe('reviews store', () => {
  describe('демо-режим', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      demoEngine.reset();
      setActivePinia(createPinia());
      useAppStore().mode = 'demo';
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('loadFor кладёт копии строк движка (свежие идентичности)', async () => {
      const store = useReviewsStore();
      await store.loadFor('demo-milky-way');

      const list = store.byMovie['demo-milky-way'];
      expect(list).toHaveLength(2); // сиды
      // стор живёт своими объектами — движок мутирует свои вне реактивности
      const engineRows = demoEngine.reviewsOf('demo-milky-way');
      expect(list.every((r, i) => r !== engineRows[i])).toBe(true);
    });

    it('create: после брони пишет отзыв и обновляет рейтинг в каталоге', async () => {
      await confirmDemoBooking();
      const store = useReviewsStore();
      const movies = useMoviesStore();
      await movies.load();

      const created = await store.create('demo-cache-lady', {
        rating: 5,
        text: 'Драма века, плакала весь сеанс.',
      });

      expect(created.authorName).toBe('Гость');
      expect(store.byMovie['demo-cache-lady'][0].id).toBe(created.id);
      // агрегат на карточках обновился (afterWrite → movies.load)
      const movie = movies.movies.find((m) => m.id === 'demo-cache-lady');
      expect(movie).toMatchObject({ ratingAvg: 5, ratingCount: 1 });
    });

    it('create: дубль — ApiError 409 прокидывается экрану', async () => {
      await confirmDemoBooking();
      const store = useReviewsStore();
      await store.create('demo-cache-lady', {
        rating: 5,
        text: 'Первый и единственный отзыв.',
      });

      await expect(
        store.create('demo-cache-lady', {
          rating: 3,
          text: 'Передумал с оценкой.',
        }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(store.submitting).toBe(false);
    });

    it('remove: удаляет и пересчитывает агрегат', async () => {
      await confirmDemoBooking();
      const store = useReviewsStore();
      const movies = useMoviesStore();
      const created = await store.create('demo-cache-lady', {
        rating: 2,
        text: 'Не моё, но снимали старательно.',
      });
      await movies.load();

      await store.remove('demo-cache-lady', created.id);

      expect(store.byMovie['demo-cache-lady']).toEqual([]);
      expect(
        movies.movies.find((m) => m.id === 'demo-cache-lady')?.ratingCount,
      ).toBe(0);
      expect(store.deleting).toEqual([]);
    });
  });

  describe('live-режим (мок сети)', () => {
    beforeEach(() => {
      setActivePinia(createPinia());
      useAppStore().mode = 'live';
      vi.clearAllMocks();
    });

    it('loadFor ходит в api.movieReviews и складывает список', async () => {
      vi.mocked(api.movieReviews).mockResolvedValue([review]);
      const store = useReviewsStore();

      await store.loadFor('m-1');

      expect(api.movieReviews).toHaveBeenCalledWith('m-1');
      expect(store.byMovie['m-1']).toEqual([review]);
      expect(store.error).toBeNull();
    });

    it('loadFor: ошибка сети — в state.error', async () => {
      vi.mocked(api.movieReviews).mockRejectedValue(new Error('offline'));
      const store = useReviewsStore();

      await store.loadFor('m-1');

      expect(store.error).toBe('offline');
    });

    it('create: api.createReview + перезагрузка списка и каталога', async () => {
      vi.mocked(api.createReview).mockResolvedValue(review);
      vi.mocked(api.movieReviews).mockResolvedValue([review]);
      vi.mocked(api.movies).mockResolvedValue({
        source: 'db',
        data: [],
      });
      const store = useReviewsStore();

      const created = await store.create('m-1', { rating: 4, text: 'Хороший фильм, советую.' });

      expect(created.id).toBe('r-1');
      expect(api.createReview).toHaveBeenCalledWith('m-1', {
        rating: 4,
        text: 'Хороший фильм, советую.',
      });
      expect(api.movieReviews).toHaveBeenCalledWith('m-1');
      expect(api.movies).toHaveBeenCalled();
    });

    it('remove: 403 чужого отзыва — сообщение в state.error', async () => {
      vi.mocked(api.deleteReview).mockRejectedValue(
        new ApiError('HTTP 403', 403, JSON.stringify({ message: 'Это не ваш отзыв' })),
      );
      vi.mocked(api.movieReviews).mockResolvedValue([]);
      vi.mocked(api.movies).mockResolvedValue({ source: 'db', data: [] });
      const store = useReviewsStore();

      await store.remove('m-1', 'r-1');

      expect(store.error).toBe('Это не ваш отзыв');
      expect(store.deleting).toEqual([]);
    });
  });
});

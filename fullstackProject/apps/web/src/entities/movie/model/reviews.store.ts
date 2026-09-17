import { defineStore } from 'pinia';
import { ApiError, api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { CreateReviewPayload, Review } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useMoviesStore } from '@/entities/movie/model/movies.store';

/** сообщение из тела 409/403/400-ответа API по отзыву */
function reviewErrorMessage(err: ApiError): string {
  try {
    const body = JSON.parse(err.body) as { message?: string };
    if (body.message) return String(body.message);
  } catch {
    // тело не JSON — покажем общий текст
  }
  return 'Не удалось удалить отзыв';
}

export const useReviewsStore = defineStore('reviews', {
  state: () => ({
    /** movieId → отзывы фильма, свежие сверху */
    byMovie: {} as Record<string, Review[]>,
    /** movieId, список которого сейчас грузится */
    loadingFor: null as string | null,
    error: null as string | null,
    /** летит POST отзыва (кнопка «Отправить») */
    submitting: false,
    /** id отзывов, по которым летит запрос удаления */
    deleting: [] as string[],
  }),
  actions: {
    async loadFor(movieId: string): Promise<void> {
      this.loadingFor = movieId;
      const app = useAppStore();
      try {
        // копии строк движка: тот же контракт свежих идентичностей,
        // что у bookings.refresh (движок мутирует вне реактивности)
        this.byMovie[movieId] =
          app.mode === 'demo'
            ? demoEngine.reviewsOf(movieId).map((r) => ({ ...r }))
            : await api.movieReviews(movieId);
        this.error = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Ошибка загрузки';
      } finally {
        this.loadingFor = null;
      }
    },

    /**
     * Новый отзыв. Ошибки (403 без брони, 409 дубль, 400 валидация)
     * прокидываются вызывающему экрану — как у bookings.create.
     */
    async create(
      movieId: string,
      payload: CreateReviewPayload,
    ): Promise<Review> {
      this.submitting = true;
      const app = useAppStore();
      try {
        const review =
          app.mode === 'demo'
            ? demoEngine.createReview(movieId, payload)
            : await api.createReview(movieId, payload);
        await this.afterWrite(movieId);
        return review;
      } finally {
        this.submitting = false;
      }
    },

    /** удаление: своё или админом; ошибка — в список модалки */
    async remove(movieId: string, id: string): Promise<void> {
      this.deleting.push(id);
      const app = useAppStore();
      try {
        if (app.mode === 'demo') {
          demoEngine.deleteReview(movieId, id);
        } else {
          await api.deleteReview(movieId, id);
        }
        this.error = null;
        // перезагрузка только на успехе: неудача не должна затирать ошибку
        await this.afterWrite(movieId);
      } catch (err) {
        this.error =
          err instanceof ApiError
            ? reviewErrorMessage(err)
            : 'Не удалось удалить отзыв';
      } finally {
        this.deleting = this.deleting.filter((x) => x !== id);
      }
    },

    /** после записи: свежий список и агрегаты на карточках каталога */
    async afterWrite(movieId: string): Promise<void> {
      await this.loadFor(movieId);
      const movies = useMoviesStore();
      await movies.load();
    },
  },
});

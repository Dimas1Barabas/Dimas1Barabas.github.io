import { defineStore } from 'pinia';
import { api } from '../api/client';
import { demoEngine } from '../api/demoEngine';
import type { CreateMoviePayload, Movie, SeatMap } from '../api/types';
import { useAppStore } from './app';

export const useMoviesStore = defineStore('movies', {
  state: () => ({
    movies: [] as Movie[],
    /** откуда пришли данные: Redis-кэш или Postgres */
    source: 'db' as 'cache' | 'db',
    loading: false,
    error: null as string | null,
    /** карта занятости зала выбранного фильма (для модалки брони) */
    seatMap: null as SeatMap | null,
    seatsLoading: false,
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      const app = useAppStore();
      try {
        if (app.mode === 'demo') {
          // первый заход — «из БД», дальше — «из кэша», как с Redis в API
          const res = demoEngine.movies();
          this.movies = res.data;
          this.source = res.source;
        } else {
          const res = await api.movies();
          this.movies = res.data;
          this.source = res.source;
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    /** Занятость мест не кэшируется — гонка за место решается на бэкенде */
    async loadSeats(movieId: string): Promise<void> {
      this.seatsLoading = true;
      const app = useAppStore();
      try {
        this.seatMap =
          app.mode === 'demo'
            ? demoEngine.seatMap(movieId)
            : await api.seatMap(movieId);
      } finally {
        this.seatsLoading = false;
      }
    },

    /** новый сеанс (админ): после создания перезагружаем каталог */
    async create(payload: CreateMoviePayload): Promise<Movie> {
      const movie = await api.createMovie(payload);
      await this.load();
      return movie;
    },
  },
});

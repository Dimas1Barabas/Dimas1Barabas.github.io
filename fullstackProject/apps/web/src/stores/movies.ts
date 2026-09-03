import { defineStore } from 'pinia';
import { api } from '../api/client';
import { demoEngine } from '../api/demoEngine';
import type { Movie } from '../api/types';
import { useAppStore } from './app';

export const useMoviesStore = defineStore('movies', {
  state: () => ({
    movies: [] as Movie[],
    /** откуда пришли данные: Redis-кэш или Postgres */
    source: 'db' as 'cache' | 'db',
    loading: false,
    error: null as string | null,
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
  },
});

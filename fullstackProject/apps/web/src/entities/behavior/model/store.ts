import { defineStore } from 'pinia';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { BehaviorInsights } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';

/**
 * Витрина «Поведение» (Go-Аналитик через прокси /analytics/insights):
 * воронка пути зрителя, интерес к фильмам, страницы, места, модалка.
 * В live — за Bearer-токен админа; в демо — детерминированные числа
 * движка (страница живёт на Pages). Аналитик недоступен — available:false,
 * страница рисует честную заглушку.
 */
export const useBehaviorStore = defineStore('behavior', {
  state: () => ({
    insights: null as BehaviorInsights | null,
    /** false — Аналитик не отвечает (стенд без него/стартует) */
    available: true,
    loading: false,
    error: null as string | null,
  }),
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      if (app.mode === 'demo') {
        const res = demoEngine.behaviorInsights();
        this.insights = res.data ?? null;
        this.available = res.available;
        this.error = null;
        return;
      }
      this.loading = true;
      try {
        const res = await api.behaviorInsights();
        this.insights = res.data ?? null;
        this.available = res.available;
        this.error = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },
  },
});

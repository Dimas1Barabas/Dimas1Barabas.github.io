import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { api, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { RecommendationItem, RecommendationsBasis } from '@/shared/api/types';

/**
 * Топ «Вам понравится» от КиноСоветника. Live — GET /recommendations/my
 * за JWT (недоступность сервиса — не ошибка, блок просто скрыт); демо —
 * тот же алгоритм локально, плюс живые обновления через onChange движка
 * (вердикт брони и отзыв дописывают сигналы профиля).
 */
export const useRecommendationsStore = defineStore('recommendations', {
  state: () => ({
    items: [] as RecommendationItem[],
    basis: 'empty' as RecommendationsBasis,
    loaded: false,
    /** подписка на демо-движок уже висит (одна на жизнь стора) */
    listening: false,
  }),
  getters: {
    /** блок показываем, только когда есть чем: пусто/недоступно — скрываем */
    visible: (s) => s.loaded && s.basis !== 'unavailable' && s.items.length > 0,
  },
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      if (app.mode === 'demo') {
        const top = demoEngine.recommendations();
        this.items = top.items;
        this.basis = top.basis;
        this.loaded = true;
        this.watchDemoEngine();
        return;
      }
      if (!storedUser()) {
        // гость live: профиля нет — блок не показываем вовсе
        this.items = [];
        this.basis = 'empty';
        this.loaded = false;
        return;
      }
      try {
        const top = await api.recommendations();
        this.items = top.items;
        this.basis = top.basis;
        this.loaded = true;
      } catch {
        // рекомендации не критичны: без КиноСоветника витрина живёт
        this.items = [];
        this.basis = 'unavailable';
      }
    },
    /** демо: вердикт брони/отзыв меняют профиль — подтягиваем топ живьём */
    watchDemoEngine(): void {
      if (this.listening) return;
      this.listening = true;
      demoEngine.onChange(() => void this.refresh());
    },
  },
});

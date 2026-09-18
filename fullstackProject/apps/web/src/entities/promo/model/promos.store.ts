import { defineStore } from 'pinia';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { CreatePromoPayload, Promo } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';

export const usePromosStore = defineStore('promos', {
  state: () => ({
    promos: [] as Promo[],
    loading: false,
    error: null as string | null,
  }),
  actions: {
    async refresh(): Promise<void> {
      this.loading = true;
      this.error = null;
      const app = useAppStore();
      try {
        this.promos =
          app.mode === 'demo'
            ? // копии: движок мутирует свои объекты вне реактивности
              demoEngine.listPromos().map((p) => ({ ...p }))
            : await api.adminPromos();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    /** новый промокод (админ); ошибки — вызывающему экрану */
    async create(payload: CreatePromoPayload): Promise<Promo> {
      const app = useAppStore();
      const promo =
        app.mode === 'demo'
          ? demoEngine.createPromo(payload)
          : await api.createPromo(payload);
      await this.refresh();
      return promo;
    },
  },
});

import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { api, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { LoyaltyMy } from '@/shared/api/types';

/**
 * Уровень «Киноман» (этап 38): перки и прогресс до следующей ступени.
 * Live — GET /loyalty/my за JWT; демо — зеркало движка (траты гостя
 * CONFIRMED-бронями). Без сессии в live уровня нет — профиль попросит
 * войти; уровень не критичен, витрина молча пустеет при отказе.
 */
export const useLoyaltyStore = defineStore('loyalty', {
  state: () => ({
    status: null as LoyaltyMy | null,
    loading: false,
  }),
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      this.loading = true;
      try {
        if (app.mode === 'demo') {
          this.status = demoEngine.myLoyalty();
        } else if (storedUser()) {
          this.status = await api.myLoyalty();
        } else {
          this.status = null;
        }
      } catch {
        // витрина не критична: профиль покажет остальные секции
        this.status = null;
      } finally {
        this.loading = false;
      }
    },
  },
});

import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { api, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { Gift, GiftsMy } from '@/shared/api/types';

/**
 * Гифт-сертификаты: покупка/активация кодов и остатки. Live —
 * POST/GET /gifts за JWT; демо — зеркальная витрина движка.
 * Оплата картой — не здесь: код уходит в pay полями чекаута
 * (booking store), этот стор отвечает за страницу «Подарки».
 */
export const useGiftStore = defineStore('gift', {
  state: () => ({
    account: null as GiftsMy | null,
    loading: false,
    /** последняя покупка/активация — показать код крупно */
    last: null as Gift | null,
  }),
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      this.loading = true;
      try {
        if (app.mode === 'demo') {
          this.account = demoEngine.myGifts();
        } else if (storedUser()) {
          this.account = await api.myGifts();
        } else {
          this.account = null;
        }
      } catch {
        // витрина не критична: страница покажет пустую сумму
        this.account = null;
      } finally {
        this.loading = false;
      }
    },

    async purchase(nominalRub: number): Promise<Gift> {
      const app = useAppStore();
      const gift =
        app.mode === 'demo'
          ? demoEngine.buyGift(nominalRub)
          : await api.buyGift(nominalRub);
      this.last = gift;
      await this.refresh();
      return gift;
    },

    async activate(code: string): Promise<Gift> {
      const app = useAppStore();
      const gift =
        app.mode === 'demo'
          ? demoEngine.activateGift(code)
          : await api.activateGift(code);
      this.last = gift;
      await this.refresh();
      return gift;
    },
  },
});

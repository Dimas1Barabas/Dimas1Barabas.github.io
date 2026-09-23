import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { api, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { BonusTransaction } from '@/shared/api/types';

/**
 * Бонусный счёт: баланс и история движений. Live — GET /bonuses/my за JWT;
 * демо — счёт движка (копии: он мутирует свои объекты вне реактивности).
 * Без сессии счёта нет — тихие нули, экран оплаты просто спрячет блок.
 */
export const useBonusStore = defineStore('bonus', {
  state: () => ({
    balance: 0,
    transactions: [] as BonusTransaction[],
    loading: false,
  }),
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      this.loading = true;
      try {
        if (app.mode === 'demo') {
          const account = demoEngine.myBonuses();
          this.balance = account.balance;
          this.transactions = account.transactions.map((t) => ({ ...t }));
        } else if (storedUser()) {
          const account = await api.myBonuses();
          this.balance = account.balance;
          this.transactions = account.transactions;
        } else {
          this.balance = 0;
          this.transactions = [];
        }
      } catch {
        // счёт не критичен для оплаты: без него блок бонусов просто скрыт
        this.balance = 0;
        this.transactions = [];
      } finally {
        this.loading = false;
      }
    },
  },
});

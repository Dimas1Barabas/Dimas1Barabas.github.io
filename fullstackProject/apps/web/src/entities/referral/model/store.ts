import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { api, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { ReferralMy } from '@/shared/api/types';

/**
 * Реферальный счёт: код приглашения и статистика. Live —
 * GET /referrals/my за JWT; демо — зеркальная витрина движка.
 * Без сессии кода нет — страница «Пригласить» просит войти.
 */
export const useReferralStore = defineStore('referral', {
  state: () => ({
    account: null as ReferralMy | null,
    loading: false,
  }),
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      this.loading = true;
      try {
        if (app.mode === 'demo') {
          this.account = demoEngine.myReferrals();
        } else if (storedUser()) {
          this.account = await api.myReferrals();
        } else {
          this.account = null;
        }
      } catch {
        // статистика не критична: страница покажет пустую витрину
        this.account = null;
      } finally {
        this.loading = false;
      }
    },
  },
});

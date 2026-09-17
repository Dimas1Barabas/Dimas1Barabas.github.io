import { defineStore } from 'pinia';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { AdminStats } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';

/**
 * Админ-аналитика: агрегаты GET /api/admin/stats. В live — за Bearer-токен
 * (экран пускает только админов), в демо — из состояния движка: сиды
 * «других зрителей» + собственные брони гостя.
 */
export const useStatsStore = defineStore('stats', {
  state: () => ({
    admin: null as AdminStats | null,
    /** источник последней выдачи: Redis-кэш или свежий расчёт */
    source: 'db' as 'cache' | 'db',
    loading: false,
    error: null as string | null,
    lastUpdated: null as number | null,
  }),
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      if (app.mode === 'demo') {
        // движок отдаёт свежие копии (как JSON по проводам в live)
        const { source, data } = demoEngine.adminStats();
        this.admin = data;
        this.source = source;
        this.lastUpdated = Date.now();
        this.error = null;
        return;
      }
      this.loading = true;
      try {
        const res = await api.adminStats();
        this.admin = res.data;
        this.source = res.source;
        this.lastUpdated = Date.now();
        this.error = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },
  },
});

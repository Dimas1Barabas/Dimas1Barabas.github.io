import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { ApiError, api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { Ticket } from '@/shared/api/types';

/** человекочитаемый текст ошибки: у ApiError сообщение — в JSON-теле */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const body = JSON.parse(err.body) as { message?: unknown };
      if (typeof body.message === 'string') return body.message;
    } catch {
      /* тело не JSON — остаётся err.message */
    }
  }
  return err instanceof Error ? err.message : 'Ошибка загрузки';
}

/**
 * Билеты одной брони для экрана «на входе в зал». Ветвление demo/live —
 * как у movies/promos: движок отдаёт копии (он мутирует свои объекты
 * вне реактивности), живой API — уже новые объекты из JSON.
 */
export const useTicketsStore = defineStore('tickets', {
  state: () => ({
    tickets: [] as Ticket[],
    bookingId: null as string | null,
    loading: false,
    error: null as string | null,
  }),
  actions: {
    async load(bookingId: string): Promise<void> {
      this.loading = true;
      this.error = null;
      const app = useAppStore();
      try {
        this.tickets =
          app.mode === 'demo'
            ? demoEngine.tickets(bookingId).map((t) => ({ ...t }))
            : await api.bookingTickets(bookingId);
        this.bookingId = bookingId;
      } catch (err) {
        // 409 bookingNotConfirmed и прочее — экран покажет текстом
        this.error = errorText(err);
      } finally {
        this.loading = false;
      }
    },
    /** между бронями: сбросить стейт, чтобы не мигал чужой список */
    clear(): void {
      this.tickets = [];
      this.bookingId = null;
      this.error = null;
    },
  },
});

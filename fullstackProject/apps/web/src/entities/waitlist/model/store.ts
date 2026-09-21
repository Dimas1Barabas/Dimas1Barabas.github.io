import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { ApiError, api, apiUrl, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { MyWaitlistEntry, WaitlistStreamEvent } from '@/shared/api/types';

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
 * Лист ожидания: очередь полных сеансов + уведомление «место освободилось».
 * Live слушает тот же витринный SSE-эндпоинт (/bookings/stream, событие
 * `waitlist`) и фильтрует «своё» по storedUser — EventSource заголовков
 * не умеет. Демо подписана на onChange движка: переход записи в NOTIFIED
 * становится всплывашкой сравнением статусов (движок не реактивен).
 */
export const useWaitlistStore = defineStore('waitlist', {
  state: () => ({
    entries: [] as MyWaitlistEntry[],
    loading: false,
    joining: false,
    error: null as string | null,
    /** «место освободилось» для всплывашки; экран гасит через dismissNotified */
    lastNotified: null as WaitlistStreamEvent | null,
    source: null as EventSource | null,
    unsubscribe: null as (() => void) | null,
  }),
  getters: {
    /** своя запись по сеансу — модалке брони, чтобы показать позицию */
    entryFor:
      (state) =>
      (sessionId: string): MyWaitlistEntry | null =>
        state.entries.find((e) => e.sessionId === sessionId) ?? null,
  },
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      this.loading = true;
      try {
        if (app.mode === 'demo') {
          // копии: движок мутирует свои объекты вне реактивности
          this.entries = demoEngine.myWaitlist().map((e) => ({ ...e }));
        } else if (storedUser()) {
          this.entries = await api.myWaitlist();
        } else {
          this.entries = []; // live без сессии — очереди нет
        }
      } catch {
        this.entries = [];
      } finally {
        this.loading = false;
      }
    },

    /** встать в очередь полного сеанса; false — гвард API отказал */
    async join(sessionId: string): Promise<boolean> {
      this.error = null;
      this.joining = true;
      try {
        const app = useAppStore();
        if (app.mode === 'demo') {
          demoEngine.joinWaitlist(sessionId);
        } else {
          await api.joinWaitlist(sessionId);
        }
        await this.refresh();
        return true;
      } catch (err) {
        // 409 waitlistAlready/sessionNotFull и 410 sessionPassed — текстом
        this.error = errorText(err);
        return false;
      } finally {
        this.joining = false;
      }
    },

    /** выйти из очереди; «уже вышли» (404) — не причина для ошибки */
    async leave(sessionId: string): Promise<void> {
      try {
        const app = useAppStore();
        if (app.mode === 'demo') {
          demoEngine.leaveWaitlist(sessionId);
        } else {
          await api.leaveWaitlist(sessionId);
        }
      } catch {
        /* 404 waitlistEntryNotFound — запись уже погашена */
      }
      await this.refresh();
    },

    startListening(): void {
      const app = useAppStore();
      if (app.mode === 'demo') {
        let prev = new Map(this.entries.map((e) => [e.id, e.status]));
        this.unsubscribe = demoEngine.onChange(() => {
          void this.refresh().then(() => {
            for (const e of this.entries) {
              if (e.status === 'NOTIFIED' && prev.get(e.id) !== 'NOTIFIED') {
                // seats в демо неизвестны — всплывашке хватает контекста сеанса
                this.lastNotified = {
                  userId: e.userId,
                  sessionId: e.sessionId,
                  movieId: e.movieId,
                  movieTitle: e.movieTitle,
                  hall: e.hall,
                  sessionAt: e.startsAt,
                  seats: [],
                  notifiedAt: e.notifiedAt ?? new Date().toISOString(),
                };
              }
            }
            prev = new Map(this.entries.map((e) => [e.id, e.status]));
          });
        });
        return;
      }
      if (this.source || !storedUser()) return;
      const source = new EventSource(apiUrl('/bookings/stream'));
      source.addEventListener('waitlist', (event) => {
        const payload = JSON.parse(
          (event as MessageEvent).data,
        ) as WaitlistStreamEvent;
        if (payload.userId === storedUser()?.id) {
          this.lastNotified = payload;
          void this.refresh();
        }
      });
      this.source = source;
    },

    stopListening(): void {
      this.source?.close();
      this.source = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
    },

    /** всплывашку показали — контекст больше не нужен */
    dismissNotified(): void {
      this.lastNotified = null;
    },
  },
});

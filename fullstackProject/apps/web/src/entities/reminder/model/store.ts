import { defineStore } from 'pinia';
import { useAppStore } from '@/shared/api/app-mode';
import { apiUrl, storedUser } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { ReminderStreamEvent } from '@/shared/api/types';

/**
 * Напоминания «скоро сеанс». Live слушает витринный SSE-эндпоинт
 * (/bookings/stream, событие `reminder`) и фильтрует «своё» по
 * storedUser — EventSource заголовков не умеет. Демо подписана на
 * onChange движка: новое письмо в коллекции становится всплывашкой
 * сравнением знакомых bookingId (движок не реактивен).
 */
export const useReminderStore = defineStore('reminder', {
  state: () => ({
    /** «скоро сеанс» для баннера; экран гасит через dismissReminded */
    lastReminded: null as ReminderStreamEvent | null,
    source: null as EventSource | null,
    unsubscribe: null as (() => void) | null,
  }),
  actions: {
    startListening(): void {
      const app = useAppStore();
      if (app.mode === 'demo') {
        let known = new Set(demoEngine.reminders().map((r) => r.bookingId));
        this.unsubscribe = demoEngine.onChange(() => {
          for (const r of demoEngine.reminders()) {
            if (!known.has(r.bookingId)) {
              this.lastReminded = r; // новое письмо — в баннер
            }
          }
          known = new Set(demoEngine.reminders().map((r) => r.bookingId));
        });
        return;
      }
      if (this.source || !storedUser()) return;
      const source = new EventSource(apiUrl('/bookings/stream'));
      source.addEventListener('reminder', (event) => {
        const payload = JSON.parse(
          (event as MessageEvent).data,
        ) as ReminderStreamEvent;
        if (payload.userId === storedUser()?.id) {
          this.lastReminded = payload;
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

    /** баннер показали — контекст больше не нужен */
    dismissReminded(): void {
      this.lastReminded = null;
    },
  },
});

import { defineStore } from 'pinia';
import { ApiError, api } from '../api/client';
import { demoEngine } from '../api/demoEngine';
import type { Booking, BookingStats, CreateBookingPayload } from '../api/types';
import { useAppStore } from './app';

const POLL_MS = 3000;

/** сообщение из тела 409/400-ответа API об отмене */
function cancelErrorMessage(err: ApiError): string {
  try {
    const body = JSON.parse(err.body) as { message?: string };
    if (body.message) return String(body.message);
  } catch {
    // тело не JSON — покажем общий текст
  }
  return 'Не удалось отменить бронь';
}

export const useBookingsStore = defineStore('bookings', {
  state: () => ({
    bookings: [] as Booking[],
    stats: {
      PENDING: 0,
      CONFIRMED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    } as BookingStats,
    lastUpdated: null as number | null,
    error: null as string | null,
    creating: false,
    /** id броней, по которым летит запрос отмены (кнопка «Отменить») */
    cancelling: [] as string[],
    pollTimer: null as ReturnType<typeof setInterval> | null,
    unsubscribe: null as (() => void) | null,
  }),
  actions: {
    async refresh(): Promise<void> {
      const app = useAppStore();
      if (app.mode === 'demo') {
        this.bookings = demoEngine.list();
        this.stats = demoEngine.stats();
        this.lastUpdated = Date.now();
        return;
      }
      try {
        const [bookings, stats] = await Promise.all([
          api.bookings(),
          api.stats(),
        ]);
        this.bookings = bookings;
        this.stats = stats;
        this.lastUpdated = Date.now();
        this.error = null;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Ошибка загрузки';
      }
    },

    async create(payload: CreateBookingPayload): Promise<Booking> {
      this.creating = true;
      const app = useAppStore();
      try {
        const booking =
          app.mode === 'demo'
            ? demoEngine.create(payload)
            : await api.createBooking(payload);
        await this.refresh();
        return booking;
      } finally {
        this.creating = false;
      }
    },

    /**
     * Запуск саги отмены: статус → CANCELLING, воркер делает возврат.
     * 409 «не CONFIRMED» (двойной клик, гонка) показываем как ошибку списка.
     */
    async cancel(id: string): Promise<void> {
      const app = useAppStore();
      this.cancelling.push(id);
      try {
        if (app.mode === 'demo') {
          demoEngine.cancel(id);
        } else {
          await api.cancelBooking(id);
        }
        this.error = null;
      } catch (err) {
        this.error =
          err instanceof ApiError
            ? cancelErrorMessage(err)
            : 'Не удалось отменить бронь';
      } finally {
        this.cancelling = this.cancelling.filter((x) => x !== id);
      }
      await this.refresh();
    },

    /** Живой опрос списка; в демо-режиме движок обновляет мгновенно */
    startPolling(): void {
      this.stopPolling();
      void this.refresh();
      const app = useAppStore();
      if (app.mode === 'demo') {
        this.unsubscribe = demoEngine.onChange(() => void this.refresh());
      }
      this.pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.refresh();
      }, POLL_MS);
    },

    stopPolling(): void {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    },
  },
});

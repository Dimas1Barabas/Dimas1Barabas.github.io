import { defineStore } from 'pinia';
import { ApiError, api, apiUrl } from '../api/client';
import { demoEngine } from '../api/demoEngine';
import type {
  Booking,
  BookingStats,
  BookingStreamPayload,
  CreateBookingPayload,
} from '../api/types';
import { useAppStore } from './app';

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
    /** живое SSE-соединение (live-режим) */
    source: null as EventSource | null,
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

    /**
     * Живые обновления без опроса: в live-режиме — SSE /bookings/stream
     * (браузер сам переподключается при обрыве, по onopen делаем resync),
     * в демо-режиме — подписка на локальный движок.
     */
    startListening(): void {
      this.stopListening();
      const app = useAppStore();
      if (app.mode === 'demo') {
        void this.refresh();
        this.unsubscribe = demoEngine.onChange(() => void this.refresh());
        return;
      }
      const source = new EventSource(apiUrl('/bookings/stream'));
      source.onopen = () => void this.refresh(); // catch-up после (пере)подключения
      source.addEventListener('booking', (event) => {
        // по проводам data идёт JSON-строкой — парсим в контракта события
        this.applyStreamEvent(
          JSON.parse((event as MessageEvent).data as string) as BookingStreamPayload,
        );
      });
      this.source = source;
    },

    stopListening(): void {
      if (this.source) {
        this.source.close();
        this.source = null;
      }
      if (this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    },

    /** событие SSE «booking»: upsert брони в списке + свежая статистика */
    applyStreamEvent(payload: BookingStreamPayload): void {
      const idx = this.bookings.findIndex((b) => b.id === payload.booking.id);
      if (idx === -1) {
        this.bookings.unshift(payload.booking);
      } else {
        this.bookings.splice(idx, 1, payload.booking);
      }
      this.stats = payload.stats;
      this.lastUpdated = Date.now();
      this.error = null;
    },
  },
});

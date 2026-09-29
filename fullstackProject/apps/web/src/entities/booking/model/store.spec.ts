/** bookings store: демо-режим целиком (движок, саги оплаты и отмены). Live-поток SSE и личный кабинет — в store-live.spec.ts */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import { useBookingsStore } from '@/entities/booking/model/store';
import type { SeatMap } from '@/shared/api/types';

/** первое свободное место — чтобы тесты не зависели от посева занятости */
function freeSeats(map: SeatMap, count: number): string[] {
  const seats: string[] = [];
  outer: for (let row = 1; row <= map.layout.rows; row++) {
    for (let num = 1; num <= map.layout.seatsPerRow; num++) {
      const code = `${row}-${num}`;
      if (!map.occupied.includes(code)) {
        seats.push(code);
        if (seats.length === count) break outer;
      }
    }
  }
  return seats;
}

describe('stores: демо-режим целиком (bookings)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    demoEngine.reset();
    useAppStore().mode = 'demo';
  });

  it('bookings store: create → PENDING_PAYMENT в списке и статистике', async () => {
    const sessionId = demoEngine.movies().data[0].sessions[0].id;
    const seats = freeSeats(demoEngine.seatMap(sessionId), 2);

    const bookings = useBookingsStore();
    const booking = await bookings.create({
      sessionId: sessionId,
      customerName: 'Дмитрий',
      seats,
    });

    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.seats).toEqual(seats);
    expect(bookings.bookings[0].id).toBe(booking.id);
    expect(bookings.stats.PENDING_PAYMENT).toBeGreaterThanOrEqual(1);
    expect(bookings.error).toBeNull();
  });

  it('pay: PENDING_PAYMENT → PENDING, затем вердикт «воркера»', async () => {
    const sessionId = demoEngine.movies().data[0].sessions[0].id;
    const [seat] = freeSeats(demoEngine.seatMap(sessionId), 1);
    const bookings = useBookingsStore();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const created = await bookings.create({
      sessionId: sessionId,
      customerName: 'Оплата',
      seats: [seat],
    });

    // до оплаты «воркер» молчит — резервируем место
    await vi.advanceTimersByTimeAsync(3000);
    await bookings.refresh();
    expect(bookings.bookings[0].status).toBe('PENDING_PAYMENT');

    const paid = await bookings.pay(created.id);
    expect(paid.status).toBe('PENDING');
    expect(bookings.paying).toEqual([]); // запрос завершён

    await vi.advanceTimersByTimeAsync(3000);
    randomSpy.mockRestore();
    await bookings.refresh();

    expect(bookings.bookings[0].status).toBe('CONFIRMED');
    expect(bookings.lastUpdated).not.toBeNull();
  });

  it('pay: ошибка 409 попадает в error стора и прокидывается', async () => {
    const bookings = useBookingsStore();
    // в демо-движке нет такой брони — платёж падает
    await expect(bookings.pay('нет-такой')).rejects.toThrow();

    expect(bookings.error).toBeTruthy();
    expect(bookings.paying).toEqual([]);
  });

  it('startListening в демо-режиме подписывается на движок, не открывая SSE', async () => {
    const sessionId = demoEngine.movies().data[0].sessions[0].id;
    const bookings = useBookingsStore();

    const before = demoEngine.list().length;
    bookings.startListening();
    expect(bookings.source).toBeNull(); // демо — без EventSource
    expect(bookings.unsubscribe).not.toBeNull();

    const [seat] = freeSeats(demoEngine.seatMap(sessionId), 1);
    await bookings.create({
      sessionId: sessionId,
      customerName: 'Подписка',
      seats: [seat],
    });
    // мгновенное обновление через подписку движка
    expect(bookings.bookings.length).toBe(before + 1);

    bookings.stopListening();
    expect(bookings.unsubscribe).toBeNull();
  });

  it('cancel: сага в списке и статистике — CANCELLING, затем CANCELLED', async () => {
    const sessionId = demoEngine.movies().data[0].sessions[0].id;
    const [seat] = freeSeats(demoEngine.seatMap(sessionId), 1);
    const bookings = useBookingsStore();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const created = await bookings.create({
      sessionId: sessionId,
      customerName: 'Отмена',
      seats: [seat],
    });
    await bookings.pay(created.id);

    await vi.advanceTimersByTimeAsync(3000);
    await bookings.refresh();
    expect(bookings.bookings[0].status).toBe('CONFIRMED');

    await bookings.cancel(bookings.bookings[0].id);
    expect(bookings.bookings[0].status).toBe('CANCELLING');
    expect(bookings.stats.CANCELLING).toBeGreaterThanOrEqual(1);
    expect(bookings.cancelling).toEqual([]); // запрос завершён

    // возврат «воркера» в окне 0,8–1,6 c
    await vi.advanceTimersByTimeAsync(2000);
    randomSpy.mockRestore();
    await bookings.refresh();

    expect(bookings.bookings[0].status).toBe('CANCELLED');
    expect(bookings.stats.CANCELLED).toBeGreaterThanOrEqual(1);
    expect(bookings.error).toBeNull();
  });
});

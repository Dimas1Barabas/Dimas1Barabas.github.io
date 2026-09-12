import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, saveAuth } from '../api/client';
import { demoEngine } from '../api/demoEngine';
import { useAppStore } from './app';
import { useBookingsStore } from './bookings';
import { useMoviesStore } from './movies';
import type { Booking, BookingStats, SeatMap } from '../api/types';

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

/** EventSource-двойник: помнит URL и слушателей, умеет «приносить» события */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  private listeners = new Map<string, Set<(ev: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: { data: string }) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(type: string, payload: unknown): void {
    this.listeners
      .get(type)
      ?.forEach((cb) => cb({ data: JSON.stringify(payload) }));
  }
}

describe('stores: демо-режим целиком (movies + bookings)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    demoEngine.reset();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    useAppStore().mode = 'demo';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('movies store грузит из движка и помечает источник', async () => {
    const movies = useMoviesStore();
    await movies.load();

    expect(movies.movies.length).toBeGreaterThan(0);
    expect(['db', 'cache']).toContain(movies.source);
    expect(movies.error).toBeNull();
  });

  it('movies store грузит карту зала сеанса', async () => {
    const movies = useMoviesStore();
    await movies.load();
    await movies.loadSeats(movies.movies[0].sessions[0].id);

    expect(movies.seatMap).not.toBeNull();
    expect(movies.seatMap!.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(movies.seatMap!.free).toBeGreaterThan(0);
  });

  it('bookings store: create → PENDING в списке и статистике', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const seats = freeSeats(demoEngine.seatMap(movies.movies[0].sessions[0].id), 2);

    const bookings = useBookingsStore();
    const booking = await bookings.create({
      sessionId: movies.movies[0].sessions[0].id,
      customerName: 'Дмитрий',
      seats,
    });

    expect(booking.status).toBe('PENDING');
    expect(booking.seats).toEqual(seats);
    expect(bookings.bookings[0].id).toBe(booking.id);
    expect(bookings.stats.PENDING).toBeGreaterThanOrEqual(1);
    expect(bookings.error).toBeNull();
  });

  it('refresh подтягивает вердикт «воркера» после таймера', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const [seat] = freeSeats(demoEngine.seatMap(movies.movies[0].sessions[0].id), 1);
    const bookings = useBookingsStore();
    await bookings.create({
      sessionId: movies.movies[0].sessions[0].id,
      customerName: 'Таймер',
      seats: [seat],
    });

    await vi.advanceTimersByTimeAsync(3000);
    await bookings.refresh();

    expect(bookings.bookings[0].status).not.toBe('PENDING');
    expect(bookings.lastUpdated).not.toBeNull();
  });

  it('startListening в демо-режиме подписывается на движок, не открывая SSE', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const bookings = useBookingsStore();

    const before = demoEngine.list().length;
    bookings.startListening();
    expect(bookings.source).toBeNull(); // демо — без EventSource
    expect(bookings.unsubscribe).not.toBeNull();

    const [seat] = freeSeats(demoEngine.seatMap(movies.movies[0].sessions[0].id), 1);
    await bookings.create({
      sessionId: movies.movies[0].sessions[0].id,
      customerName: 'Подписка',
      seats: [seat],
    });
    // мгновенное обновление через подписку движка
    expect(bookings.bookings.length).toBe(before + 1);

    bookings.stopListening();
    expect(bookings.unsubscribe).toBeNull();
  });

  it('live: EventSource → /api/bookings/stream, события upsert-ят бронь и статистику', () => {
    useAppStore().mode = 'live';
    const bookings = useBookingsStore();
    bookings.startListening();

    const es = FakeEventSource.instances.at(-1)!;
    expect(es.url).toBe('/api/bookings/stream');

    const stats: BookingStats = {
      PENDING: 0,
      CONFIRMED: 1,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    };
    const booking = {
      id: 'b-sse-1',
      status: 'CONFIRMED',
    } as Booking;

    // новая бронь появляется в списке
    es.dispatch('booking', { booking, stats });
    expect(bookings.bookings[0]).toMatchObject({ id: 'b-sse-1', status: 'CONFIRMED' });
    expect(bookings.stats.CONFIRMED).toBe(1);
    expect(bookings.lastUpdated).not.toBeNull();
    expect(bookings.error).toBeNull();

    // изменение той же брони — upsert на месте, без дубля в списке
    es.dispatch('booking', {
      booking: { ...booking, status: 'CANCELLED' },
      stats: { ...stats, CONFIRMED: 0, CANCELLED: 1 },
    });
    expect(bookings.bookings).toHaveLength(1);
    expect(bookings.bookings[0].status).toBe('CANCELLED');
    expect(bookings.stats.CANCELLED).toBe(1);

    bookings.stopListening();
    expect(es.closed).toBe(true);
    expect(bookings.source).toBeNull();
  });

  it('cancel: сага в списке и статистике — CANCELLING, затем CANCELLED', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const [seat] = freeSeats(demoEngine.seatMap(movies.movies[0].sessions[0].id), 1);
    const bookings = useBookingsStore();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    await bookings.create({
      sessionId: movies.movies[0].sessions[0].id,
      customerName: 'Отмена',
      seats: [seat],
    });

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

describe('stores: личный кабинет (bookings.mine)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    useAppStore().mode = 'live';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('refreshMine кладёт свои брони и чистит ошибку', async () => {
    const mySpy = vi
      .spyOn(api, 'myBookings')
      .mockResolvedValue([{ id: 'b-my-1', userId: 'user-1' } as Booking]);

    const bookings = useBookingsStore();
    await bookings.refreshMine();

    expect(mySpy).toHaveBeenCalledOnce();
    expect(bookings.mine).toHaveLength(1);
    expect(bookings.mineError).toBeNull();
  });

  it('refreshMine: ошибка API → mineError, список не трогаем', async () => {
    vi.spyOn(api, 'myBookings').mockRejectedValue(new Error('HTTP 401'));

    const bookings = useBookingsStore();
    bookings.mine = [{ id: 'b-old' } as Booking];
    await bookings.refreshMine();

    expect(bookings.mineError).toBe('HTTP 401');
    expect(bookings.mine).toHaveLength(1); // старые данные остаются
  });

  it('SSE upsert-ит в mine только бронь вошедшего пользователя', () => {
    saveAuth('token-1', {
      id: 'user-1',
      email: 'anna@test.local',
      name: 'Анна',
      role: 'user',
      createdAt: new Date().toISOString(),
    });
    const stats: BookingStats = {
      PENDING: 1,
      CONFIRMED: 0,
      FAILED: 0,
      CANCELLING: 0,
      CANCELLED: 0,
    };

    const bookings = useBookingsStore();
    bookings.startListening();
    const es = FakeEventSource.instances.at(-1)!;

    // своя новая бронь, чужая бронь, затем изменение своей
    es.dispatch('booking', {
      booking: { id: 'mine-1', userId: 'user-1', status: 'PENDING' } as Booking,
      stats,
    });
    es.dispatch('booking', {
      booking: { id: 'other-1', userId: 'user-2', status: 'PENDING' } as Booking,
      stats,
    });
    es.dispatch('booking', {
      booking: { id: 'mine-1', userId: 'user-1', status: 'CANCELLED' } as Booking,
      stats,
    });

    expect(bookings.mine).toHaveLength(1); // чужая не попала, своя не задублилась
    expect(bookings.mine[0]).toMatchObject({ id: 'mine-1', status: 'CANCELLED' });

    bookings.stopListening();
  });
});

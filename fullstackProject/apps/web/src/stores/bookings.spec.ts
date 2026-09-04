import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '../api/demoEngine';
import { useAppStore } from './app';
import { useBookingsStore } from './bookings';
import { useMoviesStore } from './movies';
import type { SeatMap } from '../api/types';

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

describe('stores: демо-режим целиком (movies + bookings)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    demoEngine.reset();
    useAppStore().mode = 'demo';
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
    await movies.loadSeats(movies.movies[0].id);

    expect(movies.seatMap).not.toBeNull();
    expect(movies.seatMap!.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(movies.seatMap!.free).toBeGreaterThan(0);
  });

  it('bookings store: create → PENDING в списке и статистике', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const seats = freeSeats(demoEngine.seatMap(movies.movies[0].id), 2);

    const bookings = useBookingsStore();
    const booking = await bookings.create({
      movieId: movies.movies[0].id,
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
    const [seat] = freeSeats(demoEngine.seatMap(movies.movies[0].id), 1);
    const bookings = useBookingsStore();
    await bookings.create({
      movieId: movies.movies[0].id,
      customerName: 'Таймер',
      seats: [seat],
    });

    await vi.advanceTimersByTimeAsync(3000);
    await bookings.refresh();

    expect(bookings.bookings[0].status).not.toBe('PENDING');
    expect(bookings.lastUpdated).not.toBeNull();
  });

  it('startPolling подписывается на движок и останавливается', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const bookings = useBookingsStore();

    const before = demoEngine.list().length;
    bookings.startPolling();
    expect(bookings.pollTimer).not.toBeNull();

    const [seat] = freeSeats(demoEngine.seatMap(movies.movies[0].id), 1);
    await bookings.create({
      movieId: movies.movies[0].id,
      customerName: 'Опрос',
      seats: [seat],
    });
    // мгновенное обновление через подписку, не дожидаясь 3-секундного тика
    expect(bookings.bookings.length).toBe(before + 1);

    bookings.stopPolling();
    expect(bookings.pollTimer).toBeNull();
  });
});

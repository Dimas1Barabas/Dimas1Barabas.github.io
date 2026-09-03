import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '../api/demoEngine';
import { useAppStore } from './app';
import { useBookingsStore } from './bookings';
import { useMoviesStore } from './movies';

describe('stores: демо-режим целиком (movies + bookings)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    useAppStore().mode = 'demo';
  });

  it('movies store грузит из движка и помечает источник', async () => {
    const movies = useMoviesStore();
    await movies.load();

    expect(movies.movies.length).toBeGreaterThan(0);
    expect(['db', 'cache']).toContain(movies.source);
    expect(movies.error).toBeNull();
  });

  it('bookings store: create → PENDING в списке и статистике', async () => {
    const movies = useMoviesStore();
    await movies.load();

    const bookings = useBookingsStore();
    const booking = await bookings.create({
      movieId: movies.movies[0].id,
      customerName: 'Дмитрий',
      seats: 2,
    });

    expect(booking.status).toBe('PENDING');
    expect(bookings.bookings[0].id).toBe(booking.id);
    expect(bookings.stats.PENDING).toBeGreaterThanOrEqual(1);
    expect(bookings.error).toBeNull();
  });

  it('refresh подтягивает вердикт «воркера» после таймера', async () => {
    const movies = useMoviesStore();
    await movies.load();
    const bookings = useBookingsStore();
    await bookings.create({
      movieId: movies.movies[0].id,
      customerName: 'Таймер',
      seats: 1,
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

    await bookings.create({
      movieId: movies.movies[0].id,
      customerName: 'Опрос',
      seats: 1,
    });
    // мгновенное обновление через подписку, не дожидаясь 3-секундного тика
    expect(bookings.bookings.length).toBe(before + 1);

    bookings.stopPolling();
    expect(bookings.pollTimer).toBeNull();
  });
});

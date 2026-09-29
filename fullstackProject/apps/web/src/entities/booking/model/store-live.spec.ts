/** bookings store: live-режим — SSE-поток брони и личный кабинет (api-моки). Вырезано из store.spec.ts (демо-режим остался там). Самодостаточен: свой FakeEventSource. */
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, saveAuth } from '@/shared/api/client';
import { useAppStore } from '@/shared/api/app-mode';
import { useBookingsStore } from '@/entities/booking/model/store';
import type { Booking, BookingStats } from '@/shared/api/types';

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

describe('stores: live-поток (bookings)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    useAppStore().mode = 'live';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('EventSource → /api/bookings/stream, события upsert-ят бронь и статистику', () => {
    const bookings = useBookingsStore();
    bookings.startListening();

    const es = FakeEventSource.instances.at(-1)!;
    expect(es.url).toBe('/api/bookings/stream');

    const stats: BookingStats = {
      PENDING_PAYMENT: 0,
      PENDING: 0,
      CONFIRMED: 1,
      FAILED: 0,
      EXPIRED: 0,
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
      PENDING_PAYMENT: 1,
      PENDING: 1,
      CONFIRMED: 0,
      FAILED: 0,
      EXPIRED: 0,
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

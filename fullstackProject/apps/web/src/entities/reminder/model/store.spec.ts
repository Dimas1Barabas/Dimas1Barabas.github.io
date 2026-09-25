import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAuth } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import { useReminderStore } from './store';

/** EventSource-двойник: помнит слушателей, умеет «приносить» события */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
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

describe('reminder store: демо-режим', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    demoEngine.reset();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    useAppStore().mode = 'demo';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('письмо движка → всплывашка lastReminded; dismiss гасит', async () => {
    // вердикт «воркера» успешен: Math.random < SUCCESS_RATE
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const reminder = useReminderStore();
    reminder.startListening();

    // дальний сеанс афиши — будущий при любом времени суток
    const movie = demoEngine.movies().data[0];
    const session = movie.sessions.at(-1)!;
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: ['5-7'],
    });
    demoEngine.pay(booking.id);

    await vi.advanceTimersByTimeAsync(3_000); // вердикт воркера (1,2–2,8 с)
    expect(demoEngine.reminders()).toHaveLength(0); // письмо ещё ждёт окна
    await vi.advanceTimersByTimeAsync(60_000); // clamp-потолок демо-окна
    expect(demoEngine.reminders()).toHaveLength(1);

    expect(reminder.lastReminded).toMatchObject({
      bookingId: booking.id,
      movieTitle: movie.title,
      seats: ['5-7'],
    });

    reminder.dismissReminded();
    expect(reminder.lastReminded).toBeNull();

    reminder.stopListening();
    randomSpy.mockRestore();
  });

  it('возврат билетов гасит письмо — всплывашки нет', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const reminder = useReminderStore();
    reminder.startListening();

    const movie = demoEngine.movies().data[0];
    const session = movie.sessions.at(-1)!;
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: ['5-7'],
    });
    demoEngine.pay(booking.id);
    await vi.advanceTimersByTimeAsync(3_000); // CONFIRMED, письмо взведено
    expect(booking.status).toBe('CONFIRMED');

    demoEngine.cancel(booking.id); // сага возврата (0,8–1,6 c)
    await vi.advanceTimersByTimeAsync(3_000); // CANCELLED — таймер письма погашен
    await vi.advanceTimersByTimeAsync(60_000);

    expect(demoEngine.reminders()).toHaveLength(0);
    expect(reminder.lastReminded).toBeNull();

    reminder.stopListening();
    randomSpy.mockRestore();
  });
});

describe('reminder store: live-режим (SSE)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    useAppStore().mode = 'live';
    saveAuth('token', {
      id: 'user-a',
      email: 'a@test.local',
      name: 'Анна',
      role: 'user',
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('событие reminder с чужим userId игнорируется, со своим — всплывашка', () => {
    const reminder = useReminderStore();
    reminder.startListening();

    const es = FakeEventSource.instances.at(-1)!;
    expect(es.url).toContain('/bookings/stream');

    const foreign = {
      userId: 'user-b',
      bookingId: 'b-1',
      movieId: 'm-1',
      movieTitle: 'Чужое',
      hall: 'IMAX',
      sessionAt: new Date().toISOString(),
      seats: ['1-1'],
      remindedAt: new Date().toISOString(),
    };
    es.dispatch('reminder', foreign);
    expect(reminder.lastReminded).toBeNull();

    es.dispatch('reminder', { ...foreign, userId: 'user-a', movieTitle: 'Моё' });
    expect(reminder.lastReminded).toMatchObject({
      userId: 'user-a',
      movieTitle: 'Моё',
      seats: ['1-1'],
    });

    reminder.stopListening();
    expect(es.closed).toBe(true);
  });

  it('без сессии стрим не открывается', () => {
    localStorage.clear();
    const reminder = useReminderStore();
    reminder.startListening();
    expect(reminder.source).toBeNull();
  });
});

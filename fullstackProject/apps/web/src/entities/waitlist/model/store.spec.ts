import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAuth } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import { useWaitlistStore } from '@/entities/waitlist/model/store';

/** «Рекурсия-s1» — сид-«аншлаг», бронь которого — demo-seed-b15 */
const FULL_SESSION = 'demo-recursion-s1';
const SELLOUT_BOOKING = 'demo-seed-b15';

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

describe('waitlist store: демо-режим', () => {
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

  it('join полного сеанса → запись с позицией; leave → пусто', async () => {
    const waitlist = useWaitlistStore();

    const ok = await waitlist.join(FULL_SESSION);
    expect(ok).toBe(true);
    expect(waitlist.entryFor(FULL_SESSION)).toMatchObject({
      status: 'WAITING',
      position: 1,
      movieTitle: 'Рекурсия',
    });

    await waitlist.leave(FULL_SESSION);
    expect(waitlist.entryFor(FULL_SESSION)).toBeNull();
  });

  it('join неполного сеанса → false и текст ошибки из тела ApiError', async () => {
    const waitlist = useWaitlistStore();
    const sessionId = demoEngine.movies().data[0].sessions[0].id;

    const refused = await waitlist.join(sessionId);
    expect(refused).toBe(false);
    expect(waitlist.error).toContain('свободные места');
  });

  it('переход в NOTIFIED через onChange → всплывашка lastNotified', async () => {
    const waitlist = useWaitlistStore();
    await waitlist.join(FULL_SESSION);
    waitlist.startListening();

    // возврат брони аншлага освобождает зал — голова уведомлена
    const okSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    demoEngine.cancel(SELLOUT_BOOKING);
    await vi.advanceTimersByTimeAsync(2000);
    okSpy.mockRestore();

    expect(waitlist.entryFor(FULL_SESSION)?.status).toBe('NOTIFIED');
    expect(waitlist.lastNotified).toMatchObject({
      sessionId: FULL_SESSION,
      movieTitle: 'Рекурсия',
      hall: 'IMAX',
    });

    waitlist.dismissNotified();
    expect(waitlist.lastNotified).toBeNull();
    waitlist.stopListening();
  });
});

describe('waitlist store: live-режим (SSE)', () => {
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

  it('событие waitlist с чужим userId игнорируется, со своим — всплывашка', async () => {
    const waitlist = useWaitlistStore();
    waitlist.startListening();

    // myWaitlist не мокнут — live без стенда; проверяем только SSE-ветку
    const es = FakeEventSource.instances.at(-1)!;
    expect(es.url).toContain('/bookings/stream');

    const foreign = {
      userId: 'user-b',
      sessionId: 's-1',
      movieId: 'm-1',
      movieTitle: 'Чужое',
      hall: 'IMAX',
      sessionAt: new Date().toISOString(),
      seats: ['1-1'],
      notifiedAt: new Date().toISOString(),
    };
    es.dispatch('waitlist', foreign);
    expect(waitlist.lastNotified).toBeNull();

    es.dispatch('waitlist', { ...foreign, userId: 'user-a', movieTitle: 'Моё' });
    expect(waitlist.lastNotified).toMatchObject({
      userId: 'user-a',
      movieTitle: 'Моё',
      seats: ['1-1'],
    });

    waitlist.stopListening();
    expect(es.closed).toBe(true);
  });

  it('без сессии стрим не открывается', () => {
    localStorage.clear();
    const waitlist = useWaitlistStore();
    waitlist.startListening();
    expect(waitlist.source).toBeNull();
  });
});

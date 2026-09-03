import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useAppStore } from './app';

vi.mock('../api/client', () => ({
  api: {
    health: vi.fn(),
    movies: vi.fn(),
    bookings: vi.fn(),
    stats: vi.fn(),
    createBooking: vi.fn(),
  },
}));

describe('app store: выбор режима', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('живой API → режим live, health сохранён', async () => {
    vi.mocked(api.health).mockResolvedValue({
      status: 'ok',
      checks: { postgres: 'up', redis: 'up', rabbitmq: 'up' },
      uptimeSec: 42,
      timestamp: '2026-09-03T12:00:00.000Z',
    });

    const store = useAppStore();
    await store.init();

    expect(store.mode).toBe('live');
    expect(store.health?.status).toBe('ok');
  });

  it('недоступный API → демо-режим (GitHub Pages)', async () => {
    vi.mocked(api.health).mockRejectedValue(new Error('network error'));

    const store = useAppStore();
    await store.init();

    expect(store.mode).toBe('demo');
    expect(store.health).toBeNull();
  });
});

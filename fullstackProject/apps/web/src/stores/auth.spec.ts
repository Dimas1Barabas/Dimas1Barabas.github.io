import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useAuthStore } from './auth';

vi.mock('../api/client', async (importOriginal) => {
  // часть модуля (saveAuth и др.) оставляем настоящей — токен в localStorage
  const original =
    await importOriginal<typeof import('../api/client')>();
  return {
    ...original,
    api: { ...original.api, login: vi.fn(), register: vi.fn() },
  };
});

const user = {
  id: 'u-1',
  email: 'anna@example.com',
  name: 'Анна',
  role: 'user' as const,
  createdAt: '2026-09-06T10:00:00.000Z',
};

describe('auth store: сессия', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('login сохраняет токен и пользователя', async () => {
    vi.mocked(api.login).mockResolvedValue({
      accessToken: 'jwt-1',
      user,
    });

    const store = useAuthStore();
    await store.login('anna@example.com', 'secret123');

    expect(store.isAuthed).toBe(true);
    expect(store.user?.name).toBe('Анна');
    expect(localStorage.getItem('cine.token')).toBe('jwt-1');
  });

  it('logout стирает сессию', async () => {
    vi.mocked(api.login).mockResolvedValue({ accessToken: 'jwt-1', user });
    const store = useAuthStore();
    await store.login('anna@example.com', 'secret123');

    store.logout();

    expect(store.isAuthed).toBe(false);
    expect(store.user).toBeNull();
    expect(localStorage.getItem('cine.token')).toBeNull();
  });

  it('isAdmin только для роли admin', () => {
    const store = useAuthStore();
    store.apply({
      accessToken: 'jwt-2',
      user: { ...user, role: 'admin' },
    });
    expect(store.isAdmin).toBe(true);

    store.apply({ accessToken: 'jwt-3', user });
    expect(store.isAdmin).toBe(false);
  });

  it('сессия восстанавливается из localStorage', () => {
    localStorage.setItem('cine.token', 'jwt-saved');
    localStorage.setItem('cine.user', JSON.stringify(user));

    const store = useAuthStore();

    expect(store.token).toBe('jwt-saved');
    expect(store.user?.email).toBe('anna@example.com');
  });
});

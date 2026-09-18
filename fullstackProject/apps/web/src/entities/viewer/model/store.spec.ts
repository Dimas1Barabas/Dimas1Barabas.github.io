import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import { useAuthStore } from '@/entities/viewer/model/store';

vi.mock('@/shared/api/client', async (importOriginal) => {
  // часть модуля (saveAuth и др.) оставляем настоящей — токен в localStorage
  const original =
    await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...original,
    api: {
      ...original.api,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      forgotPassword: vi.fn(),
    },
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

  it('logout гасит сессию на сервере и стирает локально', async () => {
    vi.mocked(api.login).mockResolvedValue({ accessToken: 'jwt-1', user });
    vi.mocked(api.logout).mockResolvedValue(undefined);
    const store = useAuthStore();
    await store.login('anna@example.com', 'secret123');

    await store.logout();

    expect(api.logout).toHaveBeenCalled();
    expect(store.isAuthed).toBe(false);
    expect(store.user).toBeNull();
    expect(localStorage.getItem('cine.token')).toBeNull();
  });

  it('logout при недоступном API всё равно выходит локально', async () => {
    vi.mocked(api.login).mockResolvedValue({ accessToken: 'jwt-1', user });
    vi.mocked(api.logout).mockRejectedValue(new Error('сеть умерла'));
    const store = useAuthStore();
    await store.login('anna@example.com', 'secret123');

    await store.logout();

    expect(store.isAuthed).toBe(false);
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

describe('auth store: демо-режим (симуляция движком)', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
    demoEngine.reset();
    useAppStore().mode = 'demo';
  });

  it('login идёт через движок и не пишет localStorage', async () => {
    const store = useAuthStore();

    await store.login('anna@example.com', 'secret123');

    expect(store.isAuthed).toBe(true);
    expect(store.user?.name).toBe('Гость');
    expect(api.login).not.toHaveBeenCalled();
    expect(localStorage.getItem('cine.token')).toBeNull();
  });

  it('forgotPassword возвращает токен — ссылку рисует страница', async () => {
    const store = useAuthStore();

    const token = await store.forgotPassword('anna@example.com');

    expect(token).toBe('demo-reset-token');
    expect(api.forgotPassword).not.toHaveBeenCalled();
  });

  it('logout в демо не зовёт API, но чистит состояние', async () => {
    const store = useAuthStore();
    await store.login('anna@example.com', 'secret123');

    await store.logout();

    expect(api.logout).not.toHaveBeenCalled();
    expect(store.isAuthed).toBe(false);
  });

  it('смена пароля в демо: 403 движка доезжает до страницы', async () => {
    const store = useAuthStore();
    await store.login('anna@example.com', 'secret123');

    await expect(
      store.changePassword({ currentPassword: 'wrong', newPassword: 'new-secret-9' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

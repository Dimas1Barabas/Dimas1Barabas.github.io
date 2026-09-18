import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, clearAuth, saveAuth } from '@/shared/api/client';

/**
 * Транспорт: Bearer из localStorage, перехват 401 → refresh-ротация →
 * повтор. fetch мокается целиком; refresh-токен живёт в cookie и клиенту
 * не виден — свежая пара сохраняется из тела /auth/refresh.
 */

const user = {
  id: 'u-1',
  email: 'anna@example.com',
  name: 'Анна',
  role: 'user' as const,
  createdAt: '2026-09-06T10:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** мок fetch с маршрутизацией по (method, url-path) */
function mockFetch(
  routes: Array<{
    match: (path: string, method: string) => boolean;
    respond: () => Response | Promise<Response>;
  }>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^.*\/api/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const route = routes.find((r) => r.match(path, method));
    if (!route) throw new Error(`нет маршрута для ${method} ${path}`);
    return route.respond();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const calls = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => {
    const url = String(c[0]);
    const init = (c[1] ?? {}) as RequestInit;
    return {
      path: url.replace(/^.*\/api/, ''),
      method: (init.method ?? 'GET').toUpperCase(),
      auth: new Headers(init.headers).get('Authorization'),
    };
  });

describe('api client: сессия и refresh', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('подставляет Bearer из localStorage', async () => {
    saveAuth('jwt-1', user);
    const fetchMock = mockFetch([
      { match: (p, m) => p === '/bookings/my' && m === 'GET', respond: () => jsonResponse([]) },
    ]);

    await api.myBookings();

    expect(calls(fetchMock)[0].auth).toBe('Bearer jwt-1');
    // без Bearer бы и 401 не было — но заголовок проверяем явно
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('401 → один refresh → повтор запроса с новым токеном', async () => {
    saveAuth('jwt-stale', user);
    let refreshed = false;
    const fetchMock = mockFetch([
      {
        match: (p, m) => p === '/bookings/my' && m === 'GET',
        respond: () => (refreshed ? jsonResponse([]) : jsonResponse({ message: 'нет' }, 401)),
      },
      {
        match: (p, m) => p === '/auth/refresh' && m === 'POST',
        respond: () => {
          refreshed = true;
          return jsonResponse({ accessToken: 'jwt-fresh', user });
        },
      },
    ]);

    await api.myBookings();

    const log = calls(fetchMock);
    expect(log).toHaveLength(3); // исходный + refresh + повтор
    // refresh @Public: протухший Bearer ему безразличен, главное — путь и метод
    expect(log[1]).toMatchObject({ path: '/auth/refresh', method: 'POST' });
    expect(log[2]).toMatchObject({ path: '/bookings/my', auth: 'Bearer jwt-fresh' });
    expect(localStorage.getItem('cine.token')).toBe('jwt-fresh');
  });

  it('пачка параллельных 401 → ровно один refresh (single-flight)', async () => {
    saveAuth('jwt-stale', user);
    let refreshed = false;
    const fetchMock = mockFetch([
      {
        match: (p, m) => p === '/bookings/my' && m === 'GET',
        respond: () => (refreshed ? jsonResponse([]) : jsonResponse({ message: 'нет' }, 401)),
      },
      {
        match: (p, m) => p === '/bookings/stats' && m === 'GET',
        respond: () =>
          refreshed
            ? jsonResponse({ PENDING_PAYMENT: 0, PENDING: 0, CONFIRMED: 0, FAILED: 0, EXPIRED: 0, CANCELLING: 0, CANCELLED: 0 })
            : jsonResponse({ message: 'нет' }, 401),
      },
      {
        match: (p, m) => p === '/auth/refresh' && m === 'POST',
        // пауза имитирует сеть: обе 401 успевают встать в очередь ожидания
        respond: async () => {
          await new Promise((r) => setTimeout(r, 10));
          refreshed = true;
          return jsonResponse({ accessToken: 'jwt-fresh', user });
        },
      },
    ]);

    await Promise.all([api.myBookings(), api.stats()]);

    const log = calls(fetchMock);
    expect(log.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
    expect(log).toHaveLength(5); // 2 исходных + 1 refresh + 2 повтора
  });

  it('мёртвый refresh: сессия чистится, исходная ошибка — наружу', async () => {
    saveAuth('jwt-stale', user);
    mockFetch([
      { match: (p) => p === '/bookings/my', respond: () => jsonResponse({ message: 'нет' }, 401) },
      { match: (p) => p === '/auth/refresh', respond: () => jsonResponse({ message: 'Сессия недействительна' }, 401) },
    ]);

    await expect(api.myBookings()).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem('cine.token')).toBeNull();
    expect(localStorage.getItem('cine.user')).toBeNull();
  });

  it('401 самого auth-роута не запускает refresh (это приговор)', async () => {
    saveAuth('jwt-stale', user);
    const fetchMock = mockFetch([
      { match: (p, m) => p === '/auth/login' && m === 'POST', respond: () => jsonResponse({ message: 'Неверный email или пароль' }, 401) },
    ]);

    await expect(api.login({ email: 'a@b.c', password: 'wrong' })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // никакого /auth/refresh
    expect(localStorage.getItem('cine.token')).toBe('jwt-stale'); // сессию не трогали
  });

  it('без 401 refresh не вызывается вовсе', async () => {
    saveAuth('jwt-1', user);
    const fetchMock = mockFetch([
      { match: (p) => p === '/movies', respond: () => jsonResponse({ source: 'db', data: [] }) },
    ]);

    await api.movies();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clearAuth стирает сохранённую сессию', () => {
    saveAuth('jwt-1', user);
    clearAuth();
    expect(localStorage.getItem('cine.token')).toBeNull();
    expect(localStorage.getItem('cine.user')).toBeNull();
  });
});

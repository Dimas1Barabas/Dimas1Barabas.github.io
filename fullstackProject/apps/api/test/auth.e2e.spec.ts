/**
 * E2E вход и refresh-сессии — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, token, available, refreshCookieOf } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

it('auth: регистрация и логин выдали рабочий токен', async () => {
  if (!available) return;
  expect(token).toBeTruthy();
  const parts = token.split('.');
  expect(parts).toHaveLength(3); // header.payload.signature
});

it('мутации без токена — 401', async () => {
  if (!available) return;
  const res = await fetch(`${BASE}/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: '00000000-0000-0000-0000-000000000000',
      seats: ['1-1'],
    }),
  });
  expect(res.status).toBe(401);
});

describe('аккаунт: refresh-сессии', () => {
  /** свежий юзер с httpOnly-cookie от логина */
  async function freshSession(): Promise<string> {
    const email = `e2e-refresh-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Сессия' }),
    });
    const login = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    expect(login.status).toBe(200);
    return refreshCookieOf(login);
  }

  it('login выдаёт httpOnly-cookie; refresh продлевает сессию без повторного входа', async () => {
    if (!available) return;
    const cookie = await freshSession();

    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accessToken: string;
      user: { name: string };
    };
    expect(body.user.name).toBe('E2E Сессия');
    expect(refreshCookieOf(res)).toMatch(/^cine\.refresh=/);
    expect(refreshCookieOf(res)).not.toBe(cookie); // ротация

    // новый access работает на авторизованном маршруте
    const mine = await fetch(`${BASE}/bookings/my`, {
      headers: { Authorization: `Bearer ${body.accessToken}` },
    });
    expect(mine.status).toBe(200);
  });

  it('переиспользование ротированной куки → 401 и все сессии отозваны', async () => {
    if (!available) return;
    const first = await freshSession();

    const rotated = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: first },
    });
    const second = refreshCookieOf(rotated);

    const reuse = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: first },
    });
    expect(reuse.status).toBe(401);

    // reuse — улика компрометации: свежая кука того же юзера тоже мертва
    const afterReuse = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: second },
    });
    expect(afterReuse.status).toBe(401);
  });

  it('logout: 204, кука снята, refresh после logout — 401', async () => {
    if (!available) return;
    const cookie = await freshSession();

    // refresh даёт живой access + ротированную куку для logout
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const { accessToken } = (await res.json()) as { accessToken: string };
    const active = refreshCookieOf(res);

    const logout = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Cookie: active },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('cine.refresh=;');

    const refresh = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: active },
    });
    expect(refresh.status).toBe(401);
  });
});


/**
 * E2E аккаунт: профиль и восстановление пароля — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, token, available, refreshCookieOf } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('профиль и смена пароля', () => {
  /** клеймы access-токена без проверки подписи — нам нужен payload */
  function decodeJwt(t: string): Record<string, string> {
    return JSON.parse(
      Buffer.from(t.split('.')[1], 'base64').toString('utf8'),
    );
  }

  it('PATCH /users/me: имя обновляется, access несёт новые клеймы', async () => {
    if (!available) return;
    const res = await api<{ accessToken: string; user: { name: string } }>(
      '/users/me',
      { method: 'PATCH', body: JSON.stringify({ name: 'E2E Переименованный' }) },
    );
    expect(res.user.name).toBe('E2E Переименованный');

    const claims = decodeJwt(res.accessToken);
    expect(claims.name).toBe('E2E Переименованный');

    // новый access работает на авторизованном маршруте
    const mine = await fetch(`${BASE}/bookings/my`, {
      headers: { Authorization: `Bearer ${res.accessToken}` },
    });
    expect(mine.status).toBe(200);
  });

  it('смена пароля: все сессии отозваны, вход — только с новым паролем', async () => {
    if (!available) return;
    const email = `e2e-pass-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Пароль' }),
    });
    const login = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    const loginBody = (await login.json()) as { accessToken: string };
    const cookie = refreshCookieOf(login);

    const res = await fetch(`${BASE}/users/me/password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginBody.accessToken}`,
      },
      body: JSON.stringify({
        currentPassword: 'e2e-secret-1',
        newPassword: 'e2e-secret-2',
      }),
    });
    expect(res.status).toBe(200);

    // прежняя refresh-сессия мертва — смена пароля = выход отовсюду
    const refresh = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(refresh.status).toBe(401);

    // старый пароль больше не пускает, новый — да
    const oldLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'e2e-secret-2' }),
    });
    expect(newLogin.status).toBe(200);
  });

  it('смена пароля: неверный текущий — 403', async () => {
    if (!available) return;
    const res = await fetch(`${BASE}/users/me/password`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        currentPassword: 'точно-не-тот',
        newPassword: 'whatever-9',
      }),
    });
    expect(res.status).toBe(403);
  });
});

describe('восстановление пароля', () => {
  const NOTIF = process.env.E2E_NOTIF_URL ?? 'http://localhost:18082';

  /** ждём «письмо» сброса в истории notification-service и берём токен */
  async function tokenFromLetter(email: string): Promise<string | null> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(
        `${NOTIF}/notifications?bookingId=${encodeURIComponent(email)}&limit=5`,
        { signal: AbortSignal.timeout(3000) },
      ).catch(() => null);
      if (res?.ok) {
        const body = (await res.json()) as {
          items: { body: string; kind: string }[];
        };
        const letter = body.items.find((i) => i.kind === 'password_reset');
        if (letter?.body.includes('token=')) {
          return letter.body.split('token=')[1];
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  function postJson(path: string, payload: unknown): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  it('полный цикл: forgot → «письмо» notification-service → reset → вход новым', async () => {
    if (!available) return;
    // без notification-service «письмо» не прочитать — graceful-skip
    const notif = await fetch(`${NOTIF}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (!notif?.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n⚠️  notification-service недоступен на ${NOTIF} — e2e сброса пароля пропущен\n`,
      );
      return;
    }

    const email = `e2e-forgot-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Забыл' }),
    });

    const forgot = await postJson('/auth/forgot-password', { email });
    expect(forgot.status).toBe(200);

    const resetToken = await tokenFromLetter(email);
    expect(resetToken).toBeTruthy();

    const reset = await postJson('/auth/reset-password', {
      token: resetToken,
      newPassword: 'e2e-secret-9',
    });
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as { accessToken: string };
    expect(body.accessToken.split('.')).toHaveLength(3);

    // вход новым паролем работает, старым — нет
    const loginNew = await postJson('/auth/login', {
      email,
      password: 'e2e-secret-9',
    });
    expect(loginNew.status).toBe(200);
    const loginOld = await postJson('/auth/login', {
      email,
      password: 'e2e-secret-1',
    });
    expect(loginOld.status).toBe(401);

    // ссылка одноразовая
    const again = await postJson('/auth/reset-password', {
      token: resetToken,
      newPassword: 'one-more-9',
    });
    expect(again.status).toBe(400);
  }, 30_000);

  it('forgot без оракула: выдуманный email — тот же 200', async () => {
    if (!available) return;
    const known = await postJson('/auth/forgot-password', {
      email: 'admin@cine.local',
    });
    const ghost = await postJson('/auth/forgot-password', {
      email: `no-such-${Date.now()}@test.local`,
    });

    expect(ghost.status).toBe(200);
    expect(ghost.status).toBe(known.status);
  });
});


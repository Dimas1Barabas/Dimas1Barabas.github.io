/**
 * E2E двухфакторная аутентификация — против живого стенда (миграции,
 * настоящая PG, настоящие cookie). Полный цикл: настройка → включение
 * кодом → вход билетом (неверный/верный/backup) → доверенное устройство
 * → отзыв → выключение. Коды считает тот же TOTP-генератор, что и прод
 * (векторы RFC — в unit-спеке). Свой пользователь на каждый тест: setup
 * уже включённой 2FA честно отвечает 409.
 */
import { available, BASE, bootstrap } from './e2e-context';
import { totp } from '../src/twofactor/totp';

jest.setTimeout(30_000);

beforeAll(bootstrap);

interface User {
  email: string;
  password: string;
  accessToken: string;
}

/** свежий зарегистрированный и залогиненный пользователь */
async function freshUser(): Promise<User> {
  const email = `e2e-2fa-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@test.local`;
  const password = 'e2e-secret-1';
  await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'E2E Двойная' }),
  });
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { email, password, accessToken };
}

/** авторизованный вызов настроек 2FA */
function twofactorCall(
  user: User,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.accessToken}`,
      ...(init.headers as Record<string, string>),
    },
  });
}

/** сырой логин (нужен Response: set-cookie, тело билета) */
function login(
  user: User,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
}

/** второй шаг: код приложения или backup */
function secondFactor(
  body: Record<string, unknown>,
  cookies: string[] = [],
): Promise<Response> {
  return fetch(`${BASE}/auth/login/2fa`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies.length ? { Cookie: cookies.join('; ') } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** все Set-Cookie без атрибутов — Cookie-заголовком */
const cookiesOf = (res: Response): string[] =>
  res.headers.getSetCookie().map((c) => c.split(';')[0]);

/** включить 2FA пользователю и вернуть { секрет, backup-коды } */
async function enable2fa(user: User): Promise<{ secret: string; backup: string[] }> {
  const setup = (await (
    await twofactorCall(user, '/users/me/2fa/setup', { method: 'POST' })
  ).json()) as { secret: string; otpauthUri: string };
  expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);

  const enabled = await twofactorCall(user, '/users/me/2fa/enable', {
    method: 'POST',
    body: JSON.stringify({ code: totp(setup.secret) }),
  });
  expect(enabled.status).toBe(200);
  const { backupCodes } = (await enabled.json()) as { backupCodes: string[] };
  expect(backupCodes).toHaveLength(10);
  return { secret: setup.secret, backup: backupCodes };
}

it('включение: QR-ссылка, неверный код 401, верный включает, повтор — 409', async () => {
  if (!available) return;
  const user = await freshUser();

  const setup = await twofactorCall(user, '/users/me/2fa/setup', { method: 'POST' });
  expect(setup.status).toBe(201);
  const setupBody = (await setup.json()) as { secret: string; otpauthUri: string };
  expect(setupBody.otpauthUri).toContain('otpauth://totp/CineBooking%3A');

  const wrong = await twofactorCall(user, '/users/me/2fa/enable', {
    method: 'POST',
    body: JSON.stringify({ code: '000000' }),
  });
  expect(wrong.status).toBe(401);

  const ok = await twofactorCall(user, '/users/me/2fa/enable', {
    method: 'POST',
    body: JSON.stringify({ code: totp(setupBody.secret) }),
  });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { backupCodes: string[] }).backupCodes).toHaveLength(10);

  const status = await twofactorCall(user, '/users/me/2fa');
  expect(await status.json()).toEqual({ enabled: true, pending: false });

  const again = await twofactorCall(user, '/users/me/2fa/enable', {
    method: 'POST',
    body: JSON.stringify({ code: '123456' }),
  });
  expect(again.status).toBe(409);
});

it('логин с 2FA: билет вместо пары, без refresh-cookie', async () => {
  if (!available) return;
  const user = await freshUser();
  await enable2fa(user);

  const res = await login(user);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { twoFactorRequired?: boolean; ticket?: string };
  expect(body.twoFactorRequired).toBe(true);
  expect(body.ticket).toBeTruthy();
  expect(res.headers.get('set-cookie')).toBeNull();
});

it('второй шаг: неверный код 401, верный — пара и refresh-cookie; билет одноразовый', async () => {
  if (!available) return;
  const user = await freshUser();
  const { secret } = await enable2fa(user);
  const first = await login(user);
  const { ticket } = (await first.json()) as { ticket: string };

  const wrong = await secondFactor({ ticket, code: '999999' });
  expect(wrong.status).toBe(401);

  const ok = await secondFactor({ ticket, code: totp(secret) });
  expect(ok.status).toBe(200);
  const pair = (await ok.json()) as { accessToken: string; user: { email: string } };
  expect(pair.accessToken.split('.')).toHaveLength(3);
  expect(pair.user.email).toBe(user.email);
  expect(cookiesOf(ok).some((c) => c.startsWith('cine.refresh='))).toBe(true);

  const replay = await secondFactor({ ticket, code: totp(secret) });
  expect(replay.status).toBe(401);
});

it('backup-код и доверенное устройство: вход без кода, отзыв возвращает шаг', async () => {
  if (!available) return;
  const user = await freshUser();
  const { backup } = await enable2fa(user);

  const first = await login(user);
  const { ticket } = (await first.json()) as { ticket: string };
  const trusted = await secondFactor({
    ticket,
    code: backup[2].toLowerCase(),
    trustDevice: true,
    deviceName: 'E2E ноутбук',
  });
  expect(trusted.status).toBe(200);
  const cookies = cookiesOf(trusted);
  expect(cookies.some((c) => c.startsWith('cine.refresh='))).toBe(true);
  expect(cookies.find((c) => c.startsWith('cine.device='))).toBeTruthy();
  expect(cookies.find((c) => c.startsWith('cine.device.id='))).toBeTruthy();

  // следующий вход — пара сразу, второго шага нет
  const second = await login(user, { Cookie: cookies.join('; ') });
  const body = (await second.json()) as {
    accessToken?: string;
    twoFactorRequired?: boolean;
  };
  expect(body.accessToken).toBeTruthy();
  expect(body.twoFactorRequired).toBeUndefined();

  // устройство в витрине с именем — и отзыв возвращает второй шаг
  const devices = await twofactorCall(user, '/users/me/2fa/devices');
  const list = (await devices.json()) as { id: string; name: string }[];
  expect(list.map((d) => d.name)).toContain('E2E ноутбук');

  const revoke = await twofactorCall(user, `/users/me/2fa/devices/${list[0].id}`, {
    method: 'DELETE',
  });
  expect(revoke.status).toBe(204);

  const third = await login(user, { Cookie: cookies.join('; ') });
  const thirdBody = (await third.json()) as { twoFactorRequired?: boolean };
  expect(thirdBody.twoFactorRequired).toBe(true);
});

it('выключение кодом приложения: вход снова без второго шага, устройства гасятся', async () => {
  if (!available) return;
  const user = await freshUser();
  const { secret } = await enable2fa(user);

  // доверим и отзовём вместе с выключением
  const first = await login(user);
  const { ticket } = (await first.json()) as { ticket: string };
  await secondFactor({ ticket, code: totp(secret), trustDevice: true });

  const off = await twofactorCall(user, '/users/me/2fa/disable', {
    method: 'POST',
    body: JSON.stringify({ code: totp(secret) }),
  });
  expect(off.status).toBe(204);

  const devices = await twofactorCall(user, '/users/me/2fa/devices');
  expect(await devices.json()).toEqual([]);

  const res = await login(user);
  const body = (await res.json()) as {
    accessToken?: string;
    twoFactorRequired?: boolean;
  };
  expect(body.accessToken).toBeTruthy();
  expect(body.twoFactorRequired).toBeUndefined();
});

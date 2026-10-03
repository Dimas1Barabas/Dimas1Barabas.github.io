/**
 * Общий каркас e2e-сьюта (доменные файлы *.e2e.spec.ts):
 * база стенда, проба health с graceful-skip и свой e2e-пользователь
 * на файл (свежий — в том числе корзина лимитов Привратника).
 *
 * База стенда задаётся через E2E_BASE_URL (по умолчанию http://localhost:13000/api).
 */

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:13000/api';

export let available = false;
/** accessToken e2e-пользователя этого файла: брони и отмены авторизованы */
export let token = '';

/** проба стенда + регистрация/логин своего пользователя; без стенда — skip-флаг */
export async function bootstrap(): Promise<void> {
  const res = await fetch(`${BASE}/health`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  available = !!res && res.ok;
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n⚠️  API недоступен на ${BASE} — e2e пропущен.\n` +
        `   Поднять стек: docker compose up --build (из fullstackProject)\n`,
    );
    return;
  }

  // свой пользователь на файл: email с таймстампом, чтобы не конфликтовать
  const email = `e2e-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@test.local`;
  await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бот' }),
  });
  const login = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'e2e-secret-1' }),
  });
  token = login.accessToken;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** «cine.refresh=...» из Set-Cookie — готовый Cookie-заголовок */
export function refreshCookieOf(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

export interface E2EMovie {
  id: string;
  title: string;
  sessions: { id: string; hall: string; startsAt: string }[];
}

export interface E2EStreamPayload {
  booking: E2EBooking;
  stats: Record<string, number>;
}

export interface E2EBooking {
  id: string;
  status: string;
  message: string | null;
  processedBy: string | null;
}

/** ждёт, пока бронь покинет статус `from`; возвращает саму бронь */
export async function waitForStatus(
  id: string,
  from: string,
): Promise<E2EBooking> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const list = await api<E2EBooking[]>('/bookings');
    const booking = list.find((b) => b.id === id);
    if (booking && booking.status !== from) return booking;
  }
  throw new Error(`бронь ${id} не покинула статус ${from}`);
}

/**
 * Токен админа: один вход на весь jest-процесс. Кэш живёт в globalThis —
 * у каждого спек-файла свой module-registry, локальная переменная кэшом
 * не будет (паттерн live-harness). Без кэша файлы входили админом
 * 13 раз за минуту — корзина Привратника на /auth/login (5/мин на
 * стенде) резала случайные спеки 429.
 */
export async function adminToken(): Promise<string> {
  globalThis.__e2eAdminToken ??= (async () => {
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@cine.local',
        password: 'admin-secret-1',
      }),
    });
    return login.accessToken;
  })();
  return globalThis.__e2eAdminToken;
}

declare global {
  // eslint-disable-next-line no-var
  var __e2eAdminToken: Promise<string> | undefined;
}

/**
 * Свободное место сеанса — из живой карты занятости. Хардкод мест
 * между файлами конфликтовал: CONFIRMED-брони держат места навсегда,
 * и спека, шедшая следом, получала 409 на чужое место.
 */
export async function freeSeat(sessionId: string): Promise<string> {
  const map = await api<{ occupied: string[] }>(
    `/sessions/${sessionId}/seats`,
  );
  const taken = new Set(map.occupied);
  for (let row = 1; row <= 8; row++) {
    for (let seat = 1; seat <= 10; seat++) {
      const code = `${row}-${seat}`;
      if (!taken.has(code)) return code;
    }
  }
  throw new Error(`сеанс ${sessionId}: свободных мест нет`);
}

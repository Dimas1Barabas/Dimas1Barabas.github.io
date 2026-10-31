/**
 * Каркас хаос-сьюта (этап 24): токсики toxiproxy, витрина Курьера,
 * история notification и полный цикл брони одним вызовом.
 *
 * Сьют гоняется против живого стенда с chaos-оверлеем:
 *   docker compose -f docker-compose.yml -f docker-compose.chaos.yml up
 * (или chaos-джоба CI). Без стенда/toxiproxy тесты файла тихо
 * пропускаются с предупреждением — как e2e.
 */
import { BASE } from './e2e-context';

/** HTTP API toxiproxy (host-порт chaos-оверлея) */
export const TOXI = process.env.TOXIPROXY_URL ?? 'http://localhost:18475';
/** витрина Курьера /outbox (host-порт базового стенда) */
export const RELAY = process.env.CHAOS_RELAY_URL ?? 'http://localhost:18094';
/** история писем notification-service (host-порт базового стенда) */
export const NOTIF = process.env.E2E_NOTIF_URL ?? 'http://localhost:18082';

/** зеркало chaos/toxiproxy.json — восстановление прокси после блэкаута */
export const PROXY_SPECS: Record<
  string,
  { name: string; listen: string; upstream: string }
> = {
  'pg-api': { name: 'pg-api', listen: '[::]:15433', upstream: 'postgres:5432' },
  'pg-relay': { name: 'pg-relay', listen: '[::]:15434', upstream: 'postgres:5432' },
  'amqp-api': { name: 'amqp-api', listen: '[::]:15673', upstream: 'rabbitmq:5672' },
  'amqp-relay': { name: 'amqp-relay', listen: '[::]:15674', upstream: 'rabbitmq:5672' },
};

export let ready = false;
/** токен и email своего хаос-пользователя (одно на файл, как у e2e) */
export let token = '';
export let email = '';

/** проба стенда с оверлеем + свой пользователь; без стенда — skip-флаг */
export async function chaosBootstrap(): Promise<void> {
  const health = await fetch(`${BASE}/health`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!health?.ok) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n⚠️  API недоступен на ${BASE} — хаос пропущен.\n` +
        `   Стенд: docker compose -f docker-compose.yml -f docker-compose.chaos.yml up\n`,
    );
    return;
  }
  const toxi = await fetch(`${TOXI}/proxies`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  const relay = await fetch(`${RELAY}/health`, {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  ready = !!toxi?.ok && !!relay?.ok;
  if (!ready) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n⚠️  toxiproxy (${TOXI}) или витрина Курьера (${RELAY}) недоступны — хаос пропущен.\n` +
        `   Нужен стенд с chaos-оверлеем, а не обычный e2e-стенд\n`,
    );
    return;
  }

  email = `chaos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  await capi('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'chaos-secret-1', name: 'Хаос Бот' }),
  });
  const login = await capi<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'chaos-secret-1' }),
  });
  token = login.accessToken;
}

/** API-вызов с токеном хаос-пользователя */
export async function capi<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface E2EMovie {
  id: string;
  title: string;
  sessions: { id: string; hall: string; startsAt: string }[];
}

/** свободное место сеанса — из живой карты занятости (как freeSeat у e2e) */
export async function freeSeat(sessionId: string): Promise<string> {
  const map = await capi<{ occupied: string[] }>(`/sessions/${sessionId}/seats`);
  const taken = new Set(map.occupied);
  for (let row = 1; row <= 8; row++) {
    for (let seat = 1; seat <= 10; seat++) {
      const code = `${row}-${seat}`;
      if (!taken.has(code)) return code;
    }
  }
  throw new Error(`сеанс ${sessionId}: свободных мест нет`);
}

/** полный цикл брони: создание + оплата (вердикт воркера — сценарием) */
export async function paidBooking(
  customerName: string,
  seats = 1,
): Promise<{ id: string; status: string }> {
  const movies = await capi<{ data: E2EMovie[] }>('/movies');
  const session = movies.data[0].sessions[0];
  const picked: string[] = [];
  for (let i = 0; i < seats; i++) picked.push(await freeSeat(session.id));
  const created = await capi<{ id: string; status: string }>('/bookings', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, customerName, seats: picked }),
  });
  const paid = await capi<{ id: string; status: string }>(
    `/bookings/${created.id}/pay`,
    { method: 'POST' },
  );
  return paid;
}

// --- toxiproxy: токсики и блэкауты -----------------------------------------

async function toxi(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${TOXI}${path}`, {
    signal: AbortSignal.timeout(5000),
    ...init,
  });
  if (!res.ok) throw new Error(`toxiproxy ${path}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

/**
 * Латентность ms в оба направления прокси: апстрим (клиент→база) и
 * даунстрим (ответ) —Round-Trip клиента растёт примерно на 2×ms.
 * Идемпотентно: повторный вызов заменяет токсики (409 → пересоздаём).
 */
export async function addLatency(proxy: string, ms: number): Promise<void> {
  await clearToxics(proxy);
  const mk = (name: string, stream: string) =>
    JSON.stringify({
      name,
      type: 'latency',
      stream,
      toxicity: 1,
      attributes: { latency: ms },
    });
  await toxi(`/proxies/${proxy}/toxics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: mk('chaos-latency-up', 'upstream'),
  });
  await toxi(`/proxies/${proxy}/toxics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: mk('chaos-latency-down', 'downstream'),
  });
}

/** снять все токсики прокси; отсутствие прокси (блэкаут) — не ошибка */
export async function clearToxics(proxy: string): Promise<void> {
  const res = await fetch(`${TOXI}/proxies/${proxy}`, {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res?.ok) return; // 404/недоступен — чистить нечего
  const { toxics } = (await res.json()) as { toxics: { name: string }[] };
  for (const t of toxics ?? []) {
    await toxi(`/proxies/${proxy}/toxics/${t.name}`, { method: 'DELETE' });
  }
}

/**
 * Блэкаут: удаление прокси закрывает слушающий порт и живые соединения —
 * клиенты видят честный обрыв TCP, а не молчаливый чёрный ящик.
 */
export async function blackout(proxy: string): Promise<void> {
  // сеть до toxiproxy сама по себе не ловится: недоступный контроллер —
  // ошибка харнесса, сценарий обязан покраснеть с внятной причиной
  const res = await fetch(`${TOXI}/proxies/${proxy}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`toxiproxy DELETE ${proxy}: HTTP ${res.status}`);
  }
}

/** восстановление прокси из зеркала конфига; 409 (уже есть) — норма */
export async function restore(proxy: string): Promise<void> {
  const res = await fetch(`${TOXI}/proxies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(PROXY_SPECS[proxy]),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`toxiproxy restore ${proxy}: HTTP ${res.status} ${await res.text()}`);
  }
}

// --- витрины: ассерты сценариев --------------------------------------------

export interface OutboxStats {
  pending: number;
  oldestPending: string;
  oldestPendingMs: number;
  publishedTotal: number;
  failedAttempts: number;
}

/**
 * Витрина Курьера /outbox; null — витрина недоступна или её собственный
 * PG отвалился (сам хаос): это ожидаемое состояние, сценарии различают.
 */
export async function relayStats(): Promise<OutboxStats | null> {
  const res = await fetch(`${RELAY}/outbox`, {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as OutboxStats;
}

/** ждёт pending == 0 — хвост outbox разъехался; возвращает финальную витрину */
export async function waitDrained(timeoutMs: number): Promise<OutboxStats> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await relayStats();
    if (st && st.pending === 0) return st;
    if (Date.now() >= deadline) {
      throw new Error(`хвост outbox не дренажирован за ${timeoutMs} мс: ${JSON.stringify(st)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** письмо в истории notification по kind; null — не пришло за таймаут */
async function letterFor(
  userEmail: string,
  kind: string,
  timeoutMs: number,
): Promise<{ kind: string; body: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(
      `${NOTIF}/notifications?bookingId=${encodeURIComponent(userEmail)}&limit=50`,
      { signal: AbortSignal.timeout(5000) },
    ).catch(() => null);
    if (res?.ok) {
      const { items } = (await res.json()) as {
        items: { kind: string; body: string }[];
      };
      const letter = items.find((i) => i.kind === kind);
      if (letter) return letter;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Письмо сброса пароля — единственный наблюдаемый эффект, который
 * приходит ИМЕННО через Курьера: api пишет user.password.reset в outbox,
 * письмо password_reset в истории notification может появиться только
 * после доставки события в брокер. booking_confirmed для этого не годится:
 * его публикует воркер напрямую, минуя outbox.
 */
export function resetLetter(
  userEmail: string,
  timeoutMs: number,
): Promise<{ kind: string; body: string } | null> {
  return letterFor(userEmail, 'password_reset', timeoutMs);
}

/** запрос сброса пароля: событие уходит в outbox в общей транзакции */
export async function requestPasswordReset(userEmail: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userEmail }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`forgot-password: HTTP ${res.status}`);
}

/** ждёт вердикт воркера (уход из PENDING/PENDING_PAYMENT) */
export async function waitVerdict(
  bookingId: string,
  timeoutMs = 90_000,
): Promise<{ id: string; status: string; processedBy: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = await capi<
      { id: string; status: string; processedBy: string | null }[]
    >('/bookings');
    const booking = list.find((b) => b.id === bookingId);
    if (booking && !['PENDING', 'PENDING_PAYMENT'].includes(booking.status)) {
      return booking;
    }
    if (Date.now() >= deadline) {
      throw new Error(`бронь ${bookingId} не получила вердикт за ${timeoutMs} мс`);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

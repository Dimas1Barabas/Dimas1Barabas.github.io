/**
 * E2E против живого стенда: docker compose up --build
 * Проверяет весь контур, включая Go-воркер и RabbitMQ.
 * Если API не поднят — тесты тихо пропускаются с предупреждением
 * (стек запускается только по явной команде, не из тестов).
 *
 * База стенда задаётся через E2E_BASE_URL (по умолчанию http://localhost:13000/api).
 */

import { sseFrames, waitForSseEvent } from './sse';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:13000/api';

let available = false;
/** accessToken e2e-пользователя: брони и отмены теперь авторизованы */
let token = '';

beforeAll(async () => {
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

  // свой пользователь на прогон: email с таймстампом, чтобы не конфликтовать
  const email = `e2e-${Date.now()}@test.local`;
  await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бот' }),
  });
  const login = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'e2e-secret-1' }),
  });
  token = login.accessToken;
});

jest.setTimeout(30_000);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

describe('CineBooking e2e: живой docker-стенд', () => {
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
        movieId: '00000000-0000-0000-0000-000000000000',
        seats: ['1-1'],
      }),
    });
    expect(res.status).toBe(401);
  });

  it('health: postgres, redis и rabbitmq живы', async () => {
    if (!available) return;
    const health = await api<{ status: string; checks: Record<string, string> }>('/health');
    expect(health.status).toBe('ok');
    expect(health.checks).toEqual({
      postgres: 'up',
      redis: 'up',
      rabbitmq: 'up',
    });
  });

  it('movies: из БД, затем из Redis-кэша', async () => {
    if (!available) return;
    const first = await api<{ source: string; data: unknown[] }>('/movies');
    const second = await api<{ source: string }>('/movies');

    expect(first.data.length).toBeGreaterThanOrEqual(6);
    expect(['db', 'cache']).toContain(first.source); // могли прогреть раньше
    expect(second.source).toBe('cache');
  });

  it('seats: карта зала с геометрией 8×10', async () => {
    if (!available) return;
    const movies = await api<{ data: { id: string }[] }>('/movies');
    const map = await api<{
      layout: { rows: number; seatsPerRow: number };
      occupied: string[];
      free: number;
    }>(`/movies/${movies.data[0].id}/seats`);

    expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(map.free + map.occupied.length).toBe(80);
    for (const seat of map.occupied) {
      expect(seat).toMatch(/^\d+-\d+$/);
    }
  });

  it('одно место нельзя забронировать дважды: 409 со списком мест', async () => {
    if (!available) return;
    const movies = await api<{ data: { id: string }[] }>('/movies');
    const body = {
      movieId: movies.data[0].id,
      customerName: 'E2E Гонка',
      seats: ['1-1'],
    };

    const first = await fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
    const conflict = (await second.json()) as { seatsTaken: string[] };
    expect(conflict.seatsTaken).toContain('1-1');

    // место видно занятым в карте
    const map = await api<{ occupied: string[] }>(
      `/movies/${movies.data[0].id}/seats`,
    );
    expect(map.occupied).toContain('1-1');
  });

  it('полный цикл: POST → PENDING → Go-воркер → вердикт', async () => {
    if (!available) return;
    const movies = await api<{ data: { id: string; title: string }[] }>('/movies');
    const movie = movies.data[0];

    const created = await api<{
      id: string;
      status: string;
      totalRub: number;
    }>('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        movieId: movie.id,
        customerName: 'E2E Дмитрий',
        seats: ['8-8', '8-9'],
      }),
    });

    expect(created.status).toBe('PENDING');

    // ждём вердикт воркера (обработка 1,2–2,8 c + накладные)
    const booking = await waitForStatus(created.id, 'PENDING');

    expect(['CONFIRMED', 'FAILED']).toContain(booking.status);
    expect(booking.message).toBeTruthy();
    expect(booking.processedBy).toBe('go-worker-1');
  });

  it('stats: форма ответа', async () => {
    if (!available) return;
    const stats = await api<Record<string, number>>('/bookings/stats');
    expect(stats).toHaveProperty('PENDING');
    expect(stats).toHaveProperty('CONFIRMED');
    expect(stats).toHaveProperty('FAILED');
    expect(stats).toHaveProperty('CANCELLING');
    expect(stats).toHaveProperty('CANCELLED');
  });

  it('сага отмены: cancel → CANCELLING → Go-воркер возвращает платёж', async () => {
    if (!available) return;
    const movies = await api<{ data: { id: string; title: string }[] }>('/movies');
    const movie = movies.data[0];

    // добиваемся подтверждённой брони (воркер отказывает в ~10% случаев)
    let bookingId = '';
    for (let attempt = 0; attempt < 5 && !bookingId; attempt++) {
      const created = await api<{ id: string }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          movieId: movie.id,
          customerName: `E2E отмена ${attempt}`,
          seats: [`7-${attempt + 1}`],
        }),
      });
      const verdict = await waitForStatus(created.id, 'PENDING');
      if (verdict.status === 'CONFIRMED') bookingId = created.id;
    }
    expect(bookingId).not.toBe('');

    const cancelling = await api<{ id: string; status: string }>(
      `/bookings/${bookingId}/cancel`,
      { method: 'POST' },
    );
    expect(cancelling.status).toBe('CANCELLING');

    // повторная отмена по CANCELLING — 409 (гонку закрыл статус)
    const again = await fetch(`${BASE}/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(409);

    // ждём вердикт возврата (0,8–1,6 c + накладные)
    const final = await waitForStatus(bookingId, 'CANCELLING');
    expect(['CANCELLED', 'CONFIRMED']).toContain(final.status); // CONFIRMED = банк не вернул
  });

  it('SSE: вердикт воркера приходит в стрим без опроса', async () => {
    if (!available) return;
    const movies = await api<{ data: { id: string }[] }>('/movies');

    const controller = new AbortController();
    const res = await fetch(`${BASE}/bookings/stream`, {
      signal: controller.signal,
    });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = sseFrames(res.body!);
    const created = await api<{ id: string }>('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        movieId: movies.data[0].id,
        customerName: 'E2E SSE',
        seats: ['5-5'],
      }),
    });

    // создание → PENDING в стриме (SSE-шина в API)
    const pending = await waitForSseEvent<E2EStreamPayload>(
      frames,
      'booking',
      (p) => p.booking.id === created.id && p.booking.status === 'PENDING',
    );
    expect(pending.stats).toHaveProperty('PENDING');

    // вердикт Go-воркера → ещё одно событие по той же брони, без опроса
    const verdict = await waitForSseEvent<E2EStreamPayload>(
      frames,
      'booking',
      (p) => p.booking.id === created.id && p.booking.status !== 'PENDING',
      20_000,
    );
    expect(['CONFIRMED', 'FAILED']).toContain(verdict.booking.status);
    expect(verdict.booking.processedBy).toBe('go-worker-1');
    expect(verdict.stats.PENDING).toBeLessThan(pending.stats.PENDING + 1);

    controller.abort();
  });
});

interface E2EStreamPayload {
  booking: E2EBooking;
  stats: Record<string, number>;
}

interface E2EBooking {
  id: string;
  status: string;
  message: string | null;
  processedBy: string | null;
}

/** ждёт, пока бронь покинет статус `from`; возвращает саму бронь */
async function waitForStatus(id: string, from: string): Promise<E2EBooking> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const list = await api<E2EBooking[]>('/bookings');
    const booking = list.find((b) => b.id === id);
    if (booking && booking.status !== from) return booking;
  }
  throw new Error(`бронь ${id} не покинула статус ${from}`);
}

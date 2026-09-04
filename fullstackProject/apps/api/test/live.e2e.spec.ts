/**
 * E2E против живого стенда: docker compose up --build
 * Проверяет весь контур, включая Go-воркер и RabbitMQ.
 * Если API не поднят — тесты тихо пропускаются с предупреждением
 * (стек запускается только по явной команде, не из тестов).
 *
 * База стенда задаётся через E2E_BASE_URL (по умолчанию http://localhost:13000/api).
 */

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:13000/api';

let available = false;

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
  }
});

jest.setTimeout(30_000);

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

describe('CineBooking e2e: живой docker-стенд', () => {
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    let booking: { status: string; message: string | null; processedBy: string | null } | null =
      null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const list = await api<
        { id: string; status: string; message: string | null; processedBy: string | null }[]
      >('/bookings');
      booking = list.find((b) => b.id === created.id) ?? null;
      if (booking && booking.status !== 'PENDING') break;
    }

    expect(booking).not.toBeNull();
    expect(['CONFIRMED', 'FAILED']).toContain(booking!.status);
    expect(booking!.message).toBeTruthy();
    expect(booking!.processedBy).toBe('go-worker-1');
  });

  it('stats: форма ответа', async () => {
    if (!available) return;
    const stats = await api<Record<string, number>>('/bookings/stats');
    expect(stats).toHaveProperty('PENDING');
    expect(stats).toHaveProperty('CONFIRMED');
    expect(stats).toHaveProperty('FAILED');
  });
});

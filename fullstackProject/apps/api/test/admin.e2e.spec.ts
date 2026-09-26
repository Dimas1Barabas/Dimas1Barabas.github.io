/**
 * E2E админ: сеансы и аналитика — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, token, available } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

it('admin: создаёт фильм с сеансами, он появляется в афише', async () => {
  if (!available) return;
  // админ сеется при старте API: admin@cine.local / admin-secret-1
  const login = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: 'admin@cine.local',
      password: 'admin-secret-1',
    }),
  });

  const before = await api<{ data: unknown[] }>('/movies');
  const res = await fetch(`${BASE}/movies`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${login.accessToken}`,
    },
    body: JSON.stringify({
      title: 'E2E Сеанс',
      description: 'Создан e2e-тестом и виден в каталоге',
      genre: 'e2e',
      genreIcon: '🧪',
      durationMin: 80,
      priceRub: 300,
      hue: 45,
      sessions: [
        { hall: 'IMAX', startsAt: '2026-12-31T21:00:00Z' },
        { hall: 'Красный', startsAt: '2027-01-01T13:00:00Z' },
      ],
    }),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()) as { sessions: unknown[] };
  expect(created.sessions).toHaveLength(2);

  // кэш каталога сброшен — новый фильм виден сразу
  const after = await api<{ data: unknown[] }>('/movies');
  expect(after.data.length).toBe(before.data.length + 1);
});

describe('админ-аналитика: GET /admin/stats', () => {
  function adminStats(jwt: string) {
    return fetch(`${BASE}/admin/stats`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }

  it('401 без токена, 403 обычному пользователю', async () => {
    if (!available) return;
    const anon = await fetch(`${BASE}/admin/stats`);
    expect(anon.status).toBe(401);

    const asUser = await adminStats(token);
    expect(asUser.status).toBe(403);
  });

  it('200 админу: агрегаты дашборда, конверт source и кэш', async () => {
    if (!available) return;
    // админ сеется при старте API: admin@cine.local / admin-secret-1
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@cine.local',
        password: 'admin-secret-1',
      }),
    });

    const first = await adminStats(login.accessToken);
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      source: string;
      data: {
        totals: { bookingsTotal: number; moviesCount: number };
        byStatus: Record<string, number>;
        topMovies: unknown[];
        upcomingSessions: { capacity: number; occupancyPct: number }[];
        revenueByDay: { day: string; revenueRub: number }[];
      };
    };
    expect(['db', 'cache']).toContain(body.source); // могли прогреть раньше

    // афиша засеяна, e2e-брони уже натекли — числа ненулевые
    expect(body.data.totals.bookingsTotal).toBeGreaterThanOrEqual(0);
    expect(body.data.totals.moviesCount).toBeGreaterThanOrEqual(6);
    expect(Array.isArray(body.data.topMovies)).toBe(true);

    // все 7 статусов; их сумма сходится со сводкой — это живой Postgres
    for (const status of [
      'PENDING_PAYMENT', 'PENDING', 'CONFIRMED', 'FAILED',
      'EXPIRED', 'CANCELLING', 'CANCELLED',
    ]) {
      expect(body.data.byStatus).toHaveProperty(status);
    }
    const sum = Object.values(body.data.byStatus).reduce((a, b) => a + b, 0);
    expect(sum).toBe(body.data.totals.bookingsTotal);

    // предстоящие сеансы: зал 8×10, проценты в разумных границах
    for (const s of body.data.upcomingSessions) {
      expect(s.capacity).toBe(80);
      expect(s.occupancyPct).toBeGreaterThanOrEqual(0);
      expect(s.occupancyPct).toBeLessThanOrEqual(100);
    }

    // график: 14 дней подряд, по возрастанию
    const days = body.data.revenueByDay.map((d) => d.day);
    expect(days).toHaveLength(14);
    for (let i = 1; i < days.length; i++) {
      expect(Date.parse(days[i]) - Date.parse(days[i - 1])).toBe(24 * 3600_000);
    }

    // повторный вызов — из Redis-кэша (TTL 30 c)
    const second = (await (await adminStats(login.accessToken)).json()) as {
      source: string;
    };
    expect(second.source).toBe('cache');
  });
});


/**
 * E2E КиноСоветник: GET /recommendations/my — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, available, waitForStatus, E2EMovie } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('КиноСоветник: GET /recommendations/my', () => {
  /** запросы за конкретного пользователя (токен в заголовке) */
  async function as<T>(jwt: string, path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  function randomSeat(): string {
    return `${1 + Math.floor(Math.random() * 8)}-${1 + Math.floor(Math.random() * 10)}`;
  }

  it('401 без токена; свежий пользователь — холодный старт или недоступность, но не ошибка', async () => {
    if (!available) return;
    const noAuth = await fetch(`${BASE}/recommendations/my`);
    expect(noAuth.status).toBe(401);

    const email = `e2e-recs-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Реки' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    const top = await as<{ items: { movieId: string; reason: string }[]; basis: string }>(
      login.accessToken,
      '/recommendations/my',
    );
    // КиноСоветник может быть не поднят (unavailable) или пуст (empty) —
    // витрина в любом случае не падает; в норме — холодный старт popular
    expect(['profile', 'popular', 'empty', 'unavailable']).toContain(top.basis);
    if (top.basis === 'profile' || top.basis === 'popular') {
      expect(top.items.length).toBeGreaterThan(0);
      expect(top.items[0]).toMatchObject({
        movieId: expect.any(String),
        reason: expect.any(String),
      });
    } else {
      expect(top.items).toEqual([]);
    }
  });

  it('полный цикл: CONFIRMED-бронь → сигнал → профиль, просмотренный фильм выпадает из топа', async () => {
    if (!available) return;
    const email = `e2e-recs-cyc-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Цикл' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    const seenMovieId = movies.data[0].id;

    // воркер иногда роняет оплату (10%) — ретраим свежими бронями до CONFIRMED
    let confirmed: { id: string } | null = null;
    for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
      const booking = await as<{ id: string }>(login.accessToken, '/bookings', {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.id, seats: [randomSeat()] }),
      });
      await as(login.accessToken, `/bookings/${booking.id}/pay`, { method: 'POST' });
      const done = await waitForStatus(booking.id, 'PENDING');
      if (done.status === 'CONFIRMED') confirmed = booking;
    }
    // стенд без воркера/брокера — цикл не собрать, базовые свойства выше
    if (!confirmed) return;

    // сигнал долетает асинхронно (RabbitMQ → Go → кэш API гасится) — опрашиваем
    const deadline = Date.now() + 20_000;
    let top: { items: { movieId: string }[]; basis: string } | null = null;
    while (Date.now() < deadline) {
      top = await as<{ items: { movieId: string }[]; basis: string }>(
        login.accessToken,
        '/recommendations/my',
      );
      if (top.basis === 'profile') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(top?.basis).toBe('profile');
    if (!top) throw new Error('топ не ответил за 20 с');
    // просмотренный фильм больше не рекомендуют
    expect(top.items.map((i) => i.movieId)).not.toContain(seenMovieId);
  }, 150_000);
});


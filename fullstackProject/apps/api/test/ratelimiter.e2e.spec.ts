/**
 * E2E Привратник: лимиты брони и входа (429) — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, available, E2EMovie } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('Привратник: лимиты брони и входа (429)', () => {
  /** лимиты стенда: RATE_BOOKINGS_PER_MIN / RATE_LOGIN_PER_MIN сервиса */
  const bookingsPerMin = Number(process.env.E2E_RATE_BOOKINGS_PER_MIN ?? 30);
  const loginPerMin = Number(process.env.E2E_RATE_LOGIN_PER_MIN ?? 5);

  function postJson(
    path: string,
    payload: unknown,
    bearer?: string,
  ): Promise<Response> {
    return fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(payload),
    });
  }

  /** свой пользователь: корзина брони не тронута остальным сьютом */
  async function freshUser(name: string): Promise<string> {
    const email = `e2e-rate-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    return login.accessToken;
  }

  /** сверяет тело 429 с контрактом Привратника и заголовок Retry-After */
  async function expectRateLimited(res: Response): Promise<void> {
    const body = (await res.json()) as { code: string; retryAfterSec: number };
    expect(body.code).toBe('rateLimited');
    expect(body.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get('Retry-After'))).toBe(body.retryAfterSec);
  }

  it('корзина брони: исчерпав лимит, получаем 429 c retryAfterSec', async () => {
    if (!available) return;
    const fresh = await freshUser('E2E Лимит');

    // сеанс с запасом свободных мест: первые `лимит` броней — честные 201
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    let sessionId = '';
    let freeSeats: string[] = [];
    for (const movie of movies.data) {
      for (const session of movie.sessions) {
        const map = await api<{
          layout: { rows: number; seatsPerRow: number };
          occupied: string[];
        }>(`/sessions/${session.id}/seats`);
        const all = Array.from({ length: map.layout.rows }, (_, r) =>
          Array.from(
            { length: map.layout.seatsPerRow },
            (_, s) => `${r + 1}-${s + 1}`,
          ),
        ).flat();
        const free = all.filter((code) => !map.occupied.includes(code));
        if (free.length >= bookingsPerMin) {
          sessionId = session.id;
          freeSeats = free;
          break;
        }
      }
      if (sessionId) break;
    }
    expect(freeSeats.length).toBeGreaterThanOrEqual(bookingsPerMin);

    let rejected: Response | null = null;
    let created = 0;
    // +10 запаса на долив корзины (perMin/60 в секунду, пока идёт цикл):
    // ходим, пока Привратник не откажет
    for (let i = 0; i < bookingsPerMin + 10 && !rejected; i++) {
      // свободные коды кончились — ходим по занятому: 429 бьёт 409,
      // гвард отрабатывает до валидации мест (409 тоже списывает токен)
      const seat = freeSeats[i] ?? freeSeats[0];
      const res = await postJson(
        '/bookings',
        { sessionId, customerName: 'E2E Лимит', seats: [seat] },
        fresh,
      );
      if (res.status === 429) rejected = res;
      else if (res.status === 201) created++;
      else throw new Error(`неожиданный статус брони: ${res.status}`);
    }

    expect(rejected).not.toBeNull();
    await expectRateLimited(rejected!);
    // честных броней — ровно лимит: дальше место занято, 409 без списания в created
    expect(created).toBe(bookingsPerMin);
  }, 60_000);

  it('брутфорс входа: неверные попытки тоже списывают корзину email', async () => {
    if (!available) return;
    const email = `e2e-rate-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'e2e-secret-1',
        name: 'E2E Брутфорс',
      }),
    });
    // регистрация корзину не трогает — в распоряжении все `лимит` попыток
    const attempt = () =>
      postJson('/auth/login', { email, password: 'not-the-password' });

    for (let i = 0; i < loginPerMin; i++) {
      const res = await attempt();
      expect(res.status).toBe(401); // пароль неверен, но токен списан
    }

    const rejected = await attempt();
    expect(rejected.status).toBe(429);
    await expectRateLimited(rejected);
  });
});

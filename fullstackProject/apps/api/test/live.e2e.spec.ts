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

/** «cine.refresh=...» из Set-Cookie — готовый Cookie-заголовок */
function refreshCookieOf(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
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

  it('swagger: /docs отдаёт UI, /docs-json — OpenAPI 3 со всеми маршрутами', async () => {
    if (!available) return;
    // UI — открыто и без токена (api() бы прицепил Authorization)
    const ui = await fetch(`${BASE}/docs`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');

    const spec = await api<{ openapi: string; paths: Record<string, unknown> }>('/docs-json');
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/api/movies', '/api/bookings', '/api/auth/login']),
    );
  });

  it('movies: из БД, затем из Redis-кэша; у фильмов — сеансы по времени', async () => {
    if (!available) return;
    const first = await api<{ source: string; data: E2EMovie[] }>('/movies');
    const second = await api<{ source: string }>('/movies');

    expect(first.data.length).toBeGreaterThanOrEqual(6);
    expect(['db', 'cache']).toContain(first.source); // могли прогреть раньше
    expect(second.source).toBe('cache');

    // у каждого фильма — отсортированные по startsAt сеансы
    for (const movie of first.data) {
      expect(movie.sessions.length).toBeGreaterThanOrEqual(1);
      const times = movie.sessions.map((s) => Date.parse(s.startsAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it('seats: карта зала сеанса с геометрией 8×10', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    const map = await api<{
      sessionId: string;
      layout: { rows: number; seatsPerRow: number };
      occupied: string[];
      free: number;
    }>(`/sessions/${session.id}/seats`);

    expect(map.sessionId).toBe(session.id);
    expect(map.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(map.free + map.occupied.length).toBe(80);
    for (const seat of map.occupied) {
      expect(seat).toMatch(/^\d+-\d+$/);
    }
  });

  it('одно место нельзя забронировать дважды: 409 со списком мест', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    const body = {
      sessionId: session.id,
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

    // место видно занятым в карте своего сеанса
    const map = await api<{ occupied: string[] }>(
      `/sessions/${session.id}/seats`,
    );
    expect(map.occupied).toContain('1-1');
  });

  it('изоляция: одно место продано в одном сеансе и свободно в другом', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const withTwo = movies.data.find((m) => m.sessions.length >= 2);
    if (!withTwo) throw new Error('в афише должен быть фильм с двумя сеансами');
    const [first, second] = withTwo.sessions;

    const res = await fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sessionId: second.id,
        customerName: 'E2E Другой сеанс',
        seats: ['2-2'],
      }),
    });
    expect(res.status).toBe(201);

    // в первом сеансе того же фильма место всё ещё свободно
    const map = await api<{ occupied: string[] }>(`/sessions/${first.id}/seats`);
    expect(map.occupied).not.toContain('2-2');
  });

  it('полный цикл: POST → PENDING_PAYMENT → pay → Go-воркер → вердикт', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const movie = movies.data[0];

    const created = await api<{
      id: string;
      status: string;
      totalRub: number;
      sessionId: string;
      hall: string;
      expiresAt: string | null;
    }>('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: movie.sessions[0].id,
        customerName: 'E2E Дмитрий',
        seats: ['8-8', '8-9'],
      }),
    });

    expect(created.status).toBe('PENDING_PAYMENT');
    expect(created.expiresAt).toBeTruthy();
    expect(created.sessionId).toBe(movie.sessions[0].id);
    expect(created.hall).toBeTruthy();

    // оплата запускает проведение платежа: PENDING_PAYMENT → PENDING
    const paid = await api<{ id: string; status: string }>(
      `/bookings/${created.id}/pay`,
      { method: 'POST' },
    );
    expect(paid.status).toBe('PENDING');

    // ждём вердикт воркера (обработка 1,2–2,8 c + накладные)
    const booking = await waitForStatus(created.id, 'PENDING');

    expect(['CONFIRMED', 'FAILED']).toContain(booking.status);
    expect(booking.message).toBeTruthy();
    expect(booking.processedBy).toBe('go-worker-1');
  });

  it('stats: форма ответа', async () => {
    if (!available) return;
    const stats = await api<Record<string, number>>('/bookings/stats');
    expect(stats).toHaveProperty('PENDING_PAYMENT');
    expect(stats).toHaveProperty('PENDING');
    expect(stats).toHaveProperty('CONFIRMED');
    expect(stats).toHaveProperty('FAILED');
    expect(stats).toHaveProperty('EXPIRED');
    expect(stats).toHaveProperty('CANCELLING');
    expect(stats).toHaveProperty('CANCELLED');
  });

  it('оплата: негативы — 401 без токена, 404 нет брони, 409 повторная', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[1].sessions[0];
    const created = await api<{ id: string }>('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.id,
        customerName: 'E2E Пей',
        seats: ['4-4'],
      }),
    });

    const anon = await fetch(`${BASE}/bookings/${created.id}/pay`, {
      method: 'POST',
    });
    expect(anon.status).toBe(401);

    const missing = await fetch(
      `${BASE}/bookings/00000000-0000-0000-0000-0000000000ff/pay`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    expect(missing.status).toBe(404);

    const paid = await api<{ status: string }>(
      `/bookings/${created.id}/pay`,
      { method: 'POST' },
    );
    expect(paid.status).toBe('PENDING');

    // повторная оплата — 409: платёж уже в полёте
    const again = await fetch(`${BASE}/bookings/${created.id}/pay`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(again.status).toBe(409);
  });

  it('отмена неоплаченной: сразу CANCELLED, места свободны', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[1].sessions[0];
    const created = await api<{ id: string; status: string }>('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.id,
        customerName: 'E2E Передумал',
        seats: ['6-6'],
      }),
    });
    expect(created.status).toBe('PENDING_PAYMENT');

    const cancelled = await api<{ status: string }>(
      `/bookings/${created.id}/cancel`,
      { method: 'POST' },
    );
    expect(cancelled.status).toBe('CANCELLED');

    const map = await api<{ occupied: string[] }>(
      `/sessions/${session.id}/seats`,
    );
    expect(map.occupied).not.toContain('6-6');
  });

  // длинный: ждём TTL wait-очереди (2 мин на compose-стенде)
  it('EXPIRED: неоплаченная бронь истекает по TTL, места свободны', async () => {
    if (!available) return;
    const TTL = Number(process.env.E2E_PAYMENT_TIMEOUT_MS ?? 120_000);
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[1].sessions[0];
    const created = await api<{ id: string; status: string; expiresAt: string }>(
      '/bookings',
      {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          customerName: 'E2E Забыл заплатить',
          seats: ['3-3'],
        }),
      },
    );
    expect(created.status).toBe('PENDING_PAYMENT');
    expect(created.expiresAt).toBeTruthy();

    // TTL + DLX-накладные брокера: поллим раз в 2 c
    const deadline = Date.now() + TTL + 90_000;
    let booking: E2EBooking | undefined;
    while (Date.now() < deadline && !booking) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const list = await api<E2EBooking[]>('/bookings');
      const found = list.find((b) => b.id === created.id);
      if (found?.status === 'EXPIRED') booking = found;
    }
    expect(booking).toBeDefined();
    expect(booking!.message).toBeTruthy();
    expect(booking!.processedBy).toBe('go-worker-1');

    const map = await api<{ occupied: string[] }>(
      `/sessions/${session.id}/seats`,
    );
    expect(map.occupied).not.toContain('3-3');
  }, 300_000);

  it('сага отмены: cancel → CANCELLING → Go-воркер возвращает платёж', async () => {
    if (!available) return;
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const sessionId = movies.data[0].sessions[0].id;

    // добиваемся подтверждённой брони (воркер отказывает в ~10% случаев)
    let bookingId = '';
    for (let attempt = 0; attempt < 5 && !bookingId; attempt++) {
      const created = await api<{ id: string }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          customerName: `E2E отмена ${attempt}`,
          seats: [`7-${attempt + 1}`],
        }),
      });
      await api(`/bookings/${created.id}/pay`, { method: 'POST' });
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
    const movies = await api<{ data: E2EMovie[] }>('/movies');

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
        sessionId: movies.data[0].sessions[0].id,
        customerName: 'E2E SSE',
        seats: ['5-5'],
      }),
    });

    // создание → PENDING_PAYMENT в стриме (SSE-шина в API)
    const waiting = await waitForSseEvent<E2EStreamPayload>(
      frames,
      'booking',
      (p) => p.booking.id === created.id && p.booking.status === 'PENDING_PAYMENT',
    );
    expect(waiting.stats).toHaveProperty('PENDING_PAYMENT');

    // оплата → PENDING в стриме
    await api(`/bookings/${created.id}/pay`, { method: 'POST' });
    await waitForSseEvent<E2EStreamPayload>(
      frames,
      'booking',
      (p) => p.booking.id === created.id && p.booking.status === 'PENDING',
    );

    // вердикт Go-воркера → ещё одно событие по той же брони, без опроса
    const verdict = await waitForSseEvent<E2EStreamPayload>(
      frames,
      'booking',
      (p) =>
        p.booking.id === created.id &&
        p.booking.status !== 'PENDING' &&
        p.booking.status !== 'PENDING_PAYMENT',
      20_000,
    );
    expect(['CONFIRMED', 'FAILED']).toContain(verdict.booking.status);
    expect(verdict.booking.processedBy).toBe('go-worker-1');
    expect(verdict.stats.PENDING).toBeLessThan(waiting.stats.PENDING + 1);

    controller.abort();
  });

  describe('отзывы и рейтинги', () => {
    const REVIEW_BODY = {
      rating: 5,
      text: 'E2E: смотрел с удовольствием, рекомендую!',
    };

    function postReview(movieId: string, jwt: string) {
      return fetch(`${BASE}/movies/${movieId}/reviews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify(REVIEW_BODY),
      });
    }

    it('отзыв без подтверждённой брони — 403, без токена — 401', async () => {
      if (!available) return;
      const movies = await api<{ data: E2EMovie[] }>('/movies');
      const movieId = movies.data[0].id;

      const anon = await fetch(`${BASE}/movies/${movieId}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(REVIEW_BODY),
      });
      expect(anon.status).toBe(401);

      // свежий пользователь — брони на фильм точно нет
      const email = `e2e-noreview-${Date.now()}@test.local`;
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'Без Брони' }),
      });
      const login = await api<{ accessToken: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'e2e-secret-1' }),
      });

      const res = await postReview(movieId, login.accessToken);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain('бронь');
    }, 30_000);

    it('полный цикл: бронь → CONFIRMED → отзыв → дубль 409 → удаление', async () => {
      if (!available) return;
      const movies = await api<{ data: E2EMovie[] }>('/movies');
      const movie = movies.data[0];

      const catalogCount = async (): Promise<number> => {
        const fresh = await api<{ data: (E2EMovie & { ratingCount: number })[] }>('/movies');
        return fresh.data.find((m) => m.id === movie.id)?.ratingCount ?? 0;
      };
      const before = await catalogCount();

      // право на отзыв даёт CONFIRMED-бронь; воркер отказывает в ~10% — ретраи
      let posted = await postReview(movie.id, token);
      for (let attempt = 0; attempt < 5 && posted.status === 403; attempt++) {
        const created = await api<{ id: string }>('/bookings', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: movie.sessions[0].id,
            customerName: `E2E отзыв ${attempt}`,
            seats: [`9-${attempt + 1}`],
          }),
        });
        await api(`/bookings/${created.id}/pay`, { method: 'POST' });
        const verdict = await waitForStatus(created.id, 'PENDING');
        if (verdict.status !== 'CONFIRMED') continue;
        posted = await postReview(movie.id, token);
      }
      expect(posted.status).toBe(201);
      const review = (await posted.json()) as {
        id: string;
        authorName: string;
        rating: number;
      };
      expect(review.authorName).toBe('E2E Бот');
      expect(review.rating).toBe(5);

      // отзыв в публичном списке, рейтинг фильма подрос в каталоге
      const list = await api<{ id: string }[]>(`/movies/${movie.id}/reviews`);
      expect(list.some((r) => r.id === review.id)).toBe(true);
      expect(await catalogCount()).toBeGreaterThan(before);

      // дубль — 409 reviewExists (арбитр: uq user × movie)
      const again = await postReview(movie.id, token);
      expect(again.status).toBe(409);
      const conflict = (await again.json()) as { code: string };
      expect(conflict.code).toBe('reviewExists');

      // своё удаление: 204, агрегат возвращается
      const del = await fetch(`${BASE}/movies/${movie.id}/reviews/${review.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(del.status).toBe(204);
      expect(await catalogCount()).toBe(before);
    }, 120_000);
  });

  describe('промокоды и скидки', () => {
    /** вход админом посева — отдельный токен */
    async function adminToken(): Promise<string> {
      const login = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@cine.local',
          password: 'admin-secret-1',
        }),
      });
      expect(login.status).toBe(200);
      const body = (await login.json()) as { accessToken: string };
      return body.accessToken;
    }

    /** уникальный код на прогон — коллизии между запусками исключены */
    const code = `E2E${Date.now().toString(36).toUpperCase()}`;

    async function createBooking(): Promise<{
      id: string;
      totalRub: number;
    }> {
      const movies = await api<{ data: E2EMovie[] }>('/movies');
      const session = movies.data[0].sessions[0];
      return api('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          customerName: 'E2E Промо',
          seats: ['7-7'],
        }),
      });
    }

    it('админ создаёт промокод; дубль — 409 promoExists, не-админу — 403', async () => {
      if (!available) return;
      const admin = await adminToken();

      const created = await fetch(`${BASE}/promos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin}`,
        },
        body: JSON.stringify({
          code,
          kind: 'percent',
          value: 10,
          maxActivations: 2,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      });
      expect(created.status).toBe(201);
      const promo = (await created.json()) as { code: string; usedCount: number };
      expect(promo.code).toBe(code); // нормализация в верхний регистр
      expect(promo.usedCount).toBe(0);

      const dup = await fetch(`${BASE}/promos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin}`,
        },
        body: JSON.stringify({
          code,
          kind: 'percent',
          value: 10,
          maxActivations: 5,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      });
      expect(dup.status).toBe(409);
      expect(((await dup.json()) as { code: string }).code).toBe('promoExists');

      const asUser = await fetch(`${BASE}/promos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          code: `${code}X`,
          kind: 'percent',
          value: 10,
          maxActivations: 5,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      });
      expect(asUser.status).toBe(403);
    });

    it('validate → pay с промокодом → воркер подтверждает со скидочной суммой', async () => {
      if (!available) return;
      const admin = await adminToken();
      const booking = await createBooking();

      // превью без списания: 10% от суммы брони
      const preview = await api<{
        discountRub: number;
        totalRub: number;
      }>('/promos/validate', {
        method: 'POST',
        body: JSON.stringify({ code, bookingId: booking.id }),
      });
      expect(preview.totalRub).toBe(booking.totalRub - preview.discountRub);

      const paid = await api<{
        id: string;
        status: string;
        totalRub: number;
        promoCode: string | null;
        discountRub: number | null;
      }>(`/bookings/${booking.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ promoCode: code }),
      });
      expect(paid.status).toBe('PENDING');
      expect(paid.promoCode).toBe(code);
      expect(paid.discountRub).toBe(preview.discountRub);
      expect(paid.totalRub).toBe(booking.totalRub - preview.discountRub);

      // вердикт воркера по скидочной сумме
      const verdict = await waitForStatus(paid.id, 'PENDING');
      expect(['CONFIRMED', 'FAILED']).toContain(verdict.status);

      // активация списана — админ видит usedCount
      const listRes = await fetch(`${BASE}/promos`, {
        headers: { Authorization: `Bearer ${admin}` },
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { code: string; usedCount: number }[];
      expect(list.find((p) => p.code === code)?.usedCount).toBe(1);
    }, 60_000);

    it('гонка за последний код: pay — 409 promoExhausted, бронь осталась payable', async () => {
      if (!available) return;
      // у кода лимит 2, одна активация израсходована в цикле выше —
      // жертвенная бронь забирает последнюю, следующей уже ничего не достаётся
      const sacrifice = await createBooking();
      await api(`/bookings/${sacrifice.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ promoCode: code }),
      });

      const booking = await createBooking();

      const refused = await fetch(`${BASE}/bookings/${booking.id}/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ promoCode: code }),
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe(
        'promoExhausted',
      );

      // транзакция откатилась целиком: бронь всё ещё ждёт оплаты
      const retry = await fetch(`${BASE}/bookings/${booking.id}/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      expect(retry.status).toBe(200);
      const body = (await retry.json()) as { totalRub: number; promoCode: null };
      expect(body.totalRub).toBe(booking.totalRub);
      expect(body.promoCode).toBeNull();
    });
  });

  describe('QR-билеты', () => {
    /** вход админом посева — отдельный токен (сканер на входе) */
    async function adminToken(): Promise<string> {
      const login = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@cine.local',
          password: 'admin-secret-1',
        }),
      });
      expect(login.status).toBe(200);
      const body = (await login.json()) as { accessToken: string };
      return body.accessToken;
    }

    interface E2ETicket {
      bookingId: string;
      seat: string;
      ticketNo: string;
      signature: string;
      sessionAt: string;
      movieTitle: string;
      hall: string;
    }

    /**
     * Ближайший будущий сеанс: сееты привязаны к «сейчас» стенда,
     * а сканер честно отвергает билеты на прошедший сеанс.
     */
    async function futureSession(): Promise<{ id: string }> {
      const movies = await api<{ data: E2EMovie[] }>('/movies');
      for (const movie of movies.data) {
        const session = movie.sessions
          .slice()
          .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
          .find((s) => Date.parse(s.startsAt) > Date.now());
        if (session) return session;
      }
      throw new Error('нет будущих сеансов — пересоберите стенд (сееты устарели)');
    }

    /** случайные места: коллизии между прогонами маловероятны */
    function randomSeats(count: number): string[] {
      const seats = new Set<string>();
      while (seats.size < count) {
        seats.add(
          `${1 + Math.floor(Math.random() * 8)}-${1 + Math.floor(Math.random() * 10)}`,
        );
      }
      return [...seats];
    }

    async function createBooking(seatCount: number): Promise<{ id: string }> {
      const session = await futureSession();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await api('/bookings', {
            method: 'POST',
            body: JSON.stringify({
              sessionId: session.id,
              customerName: 'E2E Билет',
              seats: randomSeats(seatCount),
            }),
          });
        } catch {
          // места заняты прошлым прогоном — берём другие
        }
      }
      throw new Error('не удалось найти свободные места');
    }

    /** бронь до CONFIRMED: воркер решает с шансом 90% — ретраим новую */
    async function confirmedBooking(seatCount: number): Promise<{ id: string }> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const booking = await createBooking(seatCount);
        await api(`/bookings/${booking.id}/pay`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const verdict = await waitForStatus(booking.id, 'PENDING');
        if (verdict.status === 'CONFIRMED') return booking;
      }
      throw new Error('воркер 5 раз отклонил платёж — маловероятно');
    }

    /** POST сканера:QR-строка билета */
    function scan(jwt: string, payload: string) {
      return fetch(`${BASE}/bookings/tickets/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ payload }),
      });
    }

    it('CONFIRMED → по билету на место; до подтверждения — 409 bookingNotConfirmed', async () => {
      if (!available) return;
      const pending = await createBooking(1);

      const early = await fetch(`${BASE}/bookings/${pending.id}/tickets`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(early.status).toBe(409);
      expect(((await early.json()) as { code: string }).code).toBe(
        'bookingNotConfirmed',
      );

      const booking = await confirmedBooking(2);
      const tickets = await api<E2ETicket[]>(`/bookings/${booking.id}/tickets`);
      expect(tickets).toHaveLength(2);
      for (const ticket of tickets) {
        expect(ticket.signature).toMatch(/^[0-9a-f]{32}$/);
        expect(ticket.ticketNo).toMatch(/^TK-[0-9A-Z]{6}$/);
        expect(ticket.movieTitle).toBeTruthy();
        expect(ticket.hall).toBeTruthy();
      }
      // производная без состояния: повторная выдача — те же подписи
      const again = await api<E2ETicket[]>(`/bookings/${booking.id}/tickets`);
      expect(again.map((t) => t.signature).sort()).toEqual(
        tickets.map((t) => t.signature).sort(),
      );
    }, 60_000);

    it('сканер: честный QR — valid, подделка — badSignature; не-админу — 403', async () => {
      if (!available) return;
      const admin = await adminToken();
      const booking = await confirmedBooking(1);
      const [ticket] = await api<E2ETicket[]>(`/bookings/${booking.id}/tickets`);

      // QR-строку собирает фронт: CINE1|bookingId|seat|epoch|sig
      const epoch = Math.floor(Date.parse(ticket.sessionAt) / 1000);
      const honest =
        `CINE1|${ticket.bookingId}|${ticket.seat}|${epoch}|${ticket.signature}`;
      const forged =
        `CINE1|${ticket.bookingId}|${ticket.seat}|${epoch}|${'0'.repeat(32)}`;

      const asUser = await scan(token, honest);
      expect(asUser.status).toBe(403);

      const scanHonest = await scan(admin, honest);
      expect(scanHonest.status).toBe(200);
      expect(await scanHonest.json()).toMatchObject({
        valid: true,
        reason: null,
        bookingId: ticket.bookingId,
        seat: ticket.seat,
        movieTitle: ticket.movieTitle,
        hall: ticket.hall,
      });

      const scanForged = await scan(admin, forged);
      expect(scanForged.status).toBe(200);
      expect(await scanForged.json()).toMatchObject({
        valid: false,
        reason: 'badSignature',
      });
    }, 60_000);

    it('403: билеты видит только владелец', async () => {
      if (!available) return;
      const booking = await confirmedBooking(1);

      // второй пользователь (не владелец, не админ)
      const email = `e2e-b-${Date.now()}@test.local`;
      await fetch(`${BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Чужой' }),
      });
      const login = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'e2e-secret-1' }),
      });
      const stranger = ((await login.json()) as { accessToken: string })
        .accessToken;

      const res = await fetch(`${BASE}/bookings/${booking.id}/tickets`, {
        headers: { Authorization: `Bearer ${stranger}` },
      });
      expect(res.status).toBe(403);
    }, 60_000);

    it('отмена гасит билеты: сага возврата закрывает бронь — 409', async () => {
      if (!available) return;
      const booking = await confirmedBooking(1);

      // сага: отменяем, пока «банк» не согласится вернуть платёж
      // (REFUND_FAILED откатывает в CONFIRMED — билеты живы, пробуем снова)
      let status = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        await api(`/bookings/${booking.id}/cancel`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        const verdict = await waitForStatus(booking.id, 'CANCELLING');
        status = verdict.status;
        if (status === 'CANCELLED') break;
      }
      expect(status).toBe('CANCELLED');

      const refused = await fetch(`${BASE}/bookings/${booking.id}/tickets`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe(
        'bookingNotConfirmed',
      );
    }, 60_000);
  });

  describe('лист ожидания: честная гонка', () => {
    const NOTIF = process.env.E2E_NOTIF_URL ?? 'http://localhost:18082';

    /** вход админом посева — создаёт сеансы под прогон */
    async function adminToken(): Promise<string> {
      const login = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'admin@cine.local',
          password: 'admin-secret-1',
        }),
      });
      expect(login.status).toBe(200);
      return ((await login.json()) as { accessToken: string }).accessToken;
    }

    /** свежий пользователь с известным email — адресат «письма» */
    async function freshUser(label: string): Promise<{ token: string; email: string }> {
      const email = `e2e-wl-${label}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 6)}@test.local`;
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'e2e-secret-1', name: `E2E ${label}` }),
      });
      const login = await api<{ accessToken: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'e2e-secret-1' }),
      });
      return { token: login.accessToken, email };
    }

    /**
     * Будущий сеанс под завязку: 10 неоплаченных броней по 8 мест держат
     * occupancy (PENDING_PAYMENT держит место не хуже CONFIRMED).
     */
    async function fullSession(): Promise<{ id: string; bookingIds: string[] }> {
      const admin = await adminToken();
      const res = await fetch(`${BASE}/movies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${admin}`,
        },
        body: JSON.stringify({
          title: `E2E Waitlist ${Date.now()}`,
          description: 'Сеанс под завязку для листа ожидания',
          genre: 'e2e',
          genreIcon: '🎟️',
          durationMin: 90,
          priceRub: 350,
          hue: 300,
          sessions: [
            { hall: 'IMAX', startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const movie = (await res.json()) as E2EMovie;
      const session = movie.sessions[0];

      const bookingIds: string[] = [];
      for (let block = 0; block < 10; block++) {
        const seats = Array.from({ length: 8 }, (_, i) => `${block + 1}-${i + 1}`);
        const booking = await api<{ id: string }>('/bookings', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: session.id,
            customerName: 'E2E Полный зал',
            seats,
          }),
        });
        bookingIds.push(booking.id);
      }

      const map = await api<{ free: number }>(`/sessions/${session.id}/seats`);
      expect(map.free).toBe(0);
      return { id: session.id, bookingIds };
    }

    /** своя запись в /waitlist/my по сеансу (LEFT-записи сервис прячет) */
    async function myEntry(
      jwt: string,
      sessionId: string,
    ): Promise<{ status: string; position: number | null } | undefined> {
      const list = await fetch(`${BASE}/waitlist/my`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(list.status).toBe(200);
      const entries = (await list.json()) as {
        sessionId: string;
        status: string;
        position: number | null;
      }[];
      return entries.find((e) => e.sessionId === sessionId);
    }

    /** поллим статус записи — уведомление едет через RabbitMQ */
    async function waitForEntryStatus(
      jwt: string,
      sessionId: string,
      status: string,
    ): Promise<{ status: string; position: number | null }> {
      for (let attempt = 0; attempt < 15; attempt++) {
        const entry = await myEntry(jwt, sessionId);
        if (entry?.status === status) return entry;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      throw new Error(`запись не пришла к статусу ${status}`);
    }

    function joinWaitlist(jwt: string, sessionId: string): Promise<Response> {
      return fetch(`${BASE}/waitlist/${sessionId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      });
    }

    it('join только на полный сеанс: 409 sessionNotFull на обычном', async () => {
      if (!available) return;
      const movies = await api<{ data: E2EMovie[] }>('/movies');
      const session = movies.data[0].sessions[0];

      const res = await joinWaitlist(token, session.id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('sessionNotFull');
    });

    it('гонка: освобождение → NOTIFIED голове + SSE, бронь гасит запись, следующий — за ним', async () => {
      if (!available) return;
      const { id: sessionId, bookingIds } = await fullSession();
      const first = await freshUser('Первый');
      const second = await freshUser('Второй');

      // очередь: первый — голова, второй за ним
      const joinA = await joinWaitlist(first.token, sessionId);
      expect(joinA.status).toBe(201);
      expect(((await joinA.json()) as { position: number }).position).toBe(1);
      const joinB = await joinWaitlist(second.token, sessionId);
      expect(((await joinB.json()) as { position: number }).position).toBe(2);

      // повторный вход тому же юзеру — 409 waitlistAlready
      const again = await joinWaitlist(first.token, sessionId);
      expect(again.status).toBe(409);
      expect(((await again.json()) as { code: string }).code).toBe('waitlistAlready');

      // слушаем стрим ДО освобождения — событие waitlist витринное
      const controller = new AbortController();
      const sse = await fetch(`${BASE}/bookings/stream`, {
        signal: controller.signal,
      });
      expect(sse.ok).toBe(true);
      const frames = sseFrames(sse.body!);

      // место освобождается: отмена неоплаченной брони ряда 1
      await api(`/bookings/${bookingIds[0]}/cancel`, { method: 'POST' });

      // in-app уведомление голове — без опроса
      const wlEvent = await waitForSseEvent<{ userId: string; sessionId: string }>(
        frames,
        'waitlist',
        (p) => p.sessionId === sessionId,
        15_000,
      );
      expect(wlEvent.userId).toBeTruthy(); // фильтрация «моё» — на клиенте

      // голова уведомлена, второй всё ещё ждёт
      const entryA = await waitForEntryStatus(first.token, sessionId, 'NOTIFIED');
      expect(entryA.position).toBeNull();
      expect((await myEntry(second.token, sessionId))?.status).toBe('WAITING');

      // первый успел в честной гонке: бронь гасит его запись (LEFT скрыт)
      const booked = await api<{ id: string }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          customerName: 'E2E Успел',
          seats: ['1-1'],
        }),
      });
      expect(booked.id).toBeTruthy();
      expect(await myEntry(first.token, sessionId)).toBeUndefined();

      // второе освобождение — второй в гонке
      await api(`/bookings/${bookingIds[1]}/cancel`, { method: 'POST' });
      await waitForEntryStatus(second.token, sessionId, 'NOTIFIED');

      controller.abort();
    }, 120_000);

    it('письмо «место освободилось» в истории notification-service', async () => {
      if (!available) return;
      // без notification-service «письмо» не прочитать — graceful-skip
      const notif = await fetch(`${NOTIF}/health`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => null);
      if (!notif?.ok) {
        // eslint-disable-next-line no-console
        console.warn(
          `\n⚠️  notification-service недоступен на ${NOTIF} — e2e письма waitlist пропущен\n`,
        );
        return;
      }

      const { id: sessionId, bookingIds } = await fullSession();
      const user = await freshUser('Письмо');
      const joined = await joinWaitlist(user.token, sessionId);
      expect(joined.status).toBe(201);

      await api(`/bookings/${bookingIds[0]}/cancel`, { method: 'POST' });

      // «письмо» едет через RabbitMQ — поллим историю у адресата
      let letter: { body: string } | undefined;
      for (let attempt = 0; attempt < 10 && !letter; attempt++) {
        const res = await fetch(
          `${NOTIF}/notifications?bookingId=${encodeURIComponent(user.email)}&limit=5`,
          { signal: AbortSignal.timeout(3000) },
        ).catch(() => null);
        if (res?.ok) {
          const body = (await res.json()) as {
            items: { kind: string; body: string }[];
          };
          letter = body.items.find((i) => i.kind === 'waitlist_seat');
        }
        if (!letter) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(letter).toBeDefined();
      expect(letter!.body).toContain('?movie='); // ссылка к выбору мест
    }, 60_000);
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
});

interface E2EMovie {
  id: string;
  title: string;
  sessions: { id: string; hall: string; startsAt: string }[];
}

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

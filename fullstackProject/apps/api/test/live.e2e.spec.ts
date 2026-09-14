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
        sessionId: '00000000-0000-0000-0000-000000000000',
        seats: ['1-1'],
      }),
    });
    expect(res.status).toBe(401);
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

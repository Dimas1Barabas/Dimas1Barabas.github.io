/**
 * E2E бронирования: гонки, lifecycle и SSE — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, token, available, waitForStatus, E2EMovie, E2EStreamPayload, E2EBooking } from './e2e-context';
import { sseFrames, waitForSseEvent } from './sse';

jest.setTimeout(30_000);

beforeAll(bootstrap);

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


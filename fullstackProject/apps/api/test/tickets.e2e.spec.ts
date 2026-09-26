/**
 * E2E QR-билеты — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, token, available, waitForStatus, E2EMovie } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

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


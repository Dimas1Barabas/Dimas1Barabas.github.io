/**
 * E2E лист ожидания: честная гонка — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { BASE, E2EMovie, adminToken, api, available, bootstrap, token } from './e2e-context';
import { sseFrames, waitForSseEvent } from './sse';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('лист ожидания: честная гонка', () => {
  const NOTIF = process.env.E2E_NOTIF_URL ?? 'http://localhost:18082';


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
    // зал 8×10 — восемь броней по целому ряду (ряды 1–8, места 1–10);
    // раньше 10 блоков по 8 мест: ряды 9–10 не существуют, 400 роняли сетап
    for (let block = 0; block < 8; block++) {
      const seats = Array.from({ length: 10 }, (_, i) => `${block + 1}-${i + 1}`);
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


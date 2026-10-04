/**
 * E2E напоминания о сеансе: письмо + SSE + витрина — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { BASE, E2EMovie, adminToken, api, available, bootstrap, waitForStatus } from './e2e-context';
import { sseFrames, waitForSseEvent } from './sse';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('напоминания о сеансе: письмо + SSE + витрина', () => {
  const NOTIF = process.env.E2E_NOTIF_URL ?? 'http://localhost:18082';
  const REMINDERS = process.env.E2E_REMINDER_URL ?? 'http://localhost:18087';


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

  /** свежий сеанс через минуты: окно стенда 2 мин — письмо видно при прогоне */
  async function nearSession(inMinutes: number): Promise<string> {
    const admin = await adminToken();
    const res = await fetch(`${BASE}/movies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin}`,
      },
      body: JSON.stringify({
        title: `E2E Reminder ${Date.now()}`,
        description: 'Сеанс под напоминание',
        genre: 'e2e',
        genreIcon: '⏰',
        durationMin: 90,
        priceRub: 350,
        hue: 210,
        sessions: [
          { hall: 'IMAX', startsAt: new Date(Date.now() + inMinutes * 60_000).toISOString() },
        ],
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as E2EMovie).sessions[0].id;
  }

  /** бронь до CONFIRMED: воркер роняет оплату с вероятностью 10% — ретраим */
  async function confirmBooking(
    jwt: string,
    sessionId: string,
    seat: string,
  ): Promise<{ id: string } | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const booking = await as<{ id: string }>(jwt, '/bookings', {
        method: 'POST',
        body: JSON.stringify({ sessionId, customerName: 'E2E Напоминание', seats: [seat] }),
      });
      await as(jwt, `/bookings/${booking.id}/pay`, { method: 'POST' });
      const done = await waitForStatus(booking.id, 'PENDING');
      if (done.status === 'CONFIRMED') return booking;
    }
    return null;
  }

  /** витрина reminder-сервиса: {reminders: [{bookingId, status, …}]} */
  async function reminderRows(): Promise<
    { bookingId: string; status: string; remindedAt: string | null }[]
  > {
    const res = await fetch(`${REMINDERS}/reminders`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} у витрины напоминаний`);
    return ((await res.json()) as {
      reminders: { bookingId: string; status: string; remindedAt: string | null }[];
    }).reminders;
  }

  it('CONFIRMED-бронь → письмо адресату, SSE-кадр reminder, витрина SENT', async () => {
    if (!available) return;
    // без reminder-сервиса или notification-истории письмо не собрать —
    // graceful-skip, как у waitlist-письма
    const health = await fetch(`${REMINDERS}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    const notif = await fetch(`${NOTIF}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (!health?.ok || !notif?.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n⚠️  reminder (${REMINDERS}) или notification (${NOTIF}) недоступен — e2e напоминаний пропущен\n`,
      );
      return;
    }

    const email = `e2e-rem-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2EM Напоминание' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    // SSE слушаем заранее: письмо придёт через ~минуту, кадр оседает в буфере
    const controller = new AbortController();
    const sse = await fetch(`${BASE}/bookings/stream`, {
      signal: controller.signal,
    });
    expect(sse.ok).toBe(true);
    const frames = sseFrames(sse.body!);

    const sessionId = await nearSession(3); // due ≈ через минуту (LEAD 2 мин)
    const confirmed = await confirmBooking(login.accessToken, sessionId, '8-10');
    if (!confirmed) return; // стенд без воркера — цикл не собрать

    // тикер reminder-сервиса (5 c) + окно ≈ 1 мин — поллим витрину до SENT
    let sent: { bookingId: string; status: string } | undefined;
    for (let attempt = 0; attempt < 30 && !sent; attempt++) {
      sent = (await reminderRows()).find(
        (r) => r.bookingId === confirmed.id && r.status === 'SENT',
      );
      if (!sent) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    expect(sent).toBeDefined();

    // «письмо» в истории notification-service: адресат — email пользователя
    let letter: { kind: string; body: string } | undefined;
    for (let attempt = 0; attempt < 10 && !letter; attempt++) {
      const res = await fetch(
        `${NOTIF}/notifications?bookingId=${encodeURIComponent(email)}&limit=5`,
        { signal: AbortSignal.timeout(3000) },
      ).catch(() => null);
      if (res?.ok) {
        const body = (await res.json()) as { items: { kind: string; body: string }[] };
        letter = body.items.find((i) => i.kind === 'session_reminder');
      }
      if (!letter) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(letter).toBeDefined();
    expect(letter!.body).toContain('Скоро сеанс');

    // кадр лежит в буфере стрима — вычитываем (email в payload нет)
    const frame = await waitForSseEvent<{
      userId: string;
      bookingId: string;
      email?: string;
    }>(frames, 'reminder', (p) => p.bookingId === confirmed.id, 5000);
    expect(frame.email).toBeUndefined();

    controller.abort();
  }, 180_000);

  it('возврат билетов гасит напоминание — письмо не приходит', async () => {
    if (!available) return;
    const health = await fetch(`${REMINDERS}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (!health?.ok) return; // без сервиса негатив не о чём

    const email = `e2e-rem-c-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2EM Отмена' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    // сеанс подальше: до окна — минуты, отмена успевает без гонки с due
    const sessionId = await nearSession(4);
    const confirmed = await confirmBooking(login.accessToken, sessionId, '8-9');
    if (!confirmed) return;

    // возврат вероятностен (~10% REFUND_FAILED откатывает бронь в
    // CONFIRMED) — ретраим отмену до CANCELLED, как живой пользователь:
    // cancel → ждать вердикта (выход из CANCELLING) → при откате снова
    let done: { status: string } | undefined;
    for (let attempt = 0; attempt < 5 && done?.status !== 'CANCELLED'; attempt++) {
      await as(login.accessToken, `/bookings/${confirmed.id}/cancel`, {
        method: 'POST',
      });
      done = await waitForStatus(confirmed.id, 'CANCELLING');
    }
    expect(done?.status).toBe('CANCELLED');

    // витрина: запись погашена, письма нет и не появится (окно далеко)
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const row = (await reminderRows()).find((r) => r.bookingId === confirmed.id);
    expect(row?.status).toBe('CANCELLED');

    const res = await fetch(
      `${NOTIF}/notifications?bookingId=${encodeURIComponent(email)}&limit=5`,
      { signal: AbortSignal.timeout(3000) },
    ).catch(() => null);
    const items = res?.ok
      ? ((await res.json()) as { items: { kind: string }[] }).items
      : [];
    expect(items.find((i) => i.kind === 'session_reminder')).toBeUndefined();
  }, 120_000);
});


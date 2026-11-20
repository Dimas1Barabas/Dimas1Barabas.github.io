/**
 * E2E антифрод «Детектив» (этап 36): скоринг чекаута на живом стенде
 * (docker compose up --build — детектив в списке джобы e2e). Каркас —
 * проба health, свой e2e-пользователь на файл, api() — в ./e2e-context.
 *
 * Сценарии считаются на честной арифметике правил: свежий счёт (+30)
 * с пятью бронями за сутки (+25) — review 55; десять броней (+35) и
 * шесть мест (+10) — block 75. Флаг checkout.new_flow включается на
 * файл (снимок — в beforeAll, откат — в afterAll, как checkout-flag).
 *
 * Стенд без детектива (k8s: сервиса нет в манифестах): первый
 * review-чекаут приходит PENDING (fail-open) — остальные сценарии
 * пропускаются с предупреждением, как бар без Бармена.
 */
import {
  adminToken,
  api,
  available,
  BASE,
  bootstrap,
  E2EMovie,
  token,
  waitForStatus,
} from './e2e-context';

jest.setTimeout(60_000);

const FLAG = 'checkout.new_flow';

interface FlagSnapshot {
  key: string;
  description: string;
  enabled: boolean;
  percentage: number;
  killed: boolean;
}

/** админ-запрос: токен один на jest-процесс (кэш в e2e-context) */
async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await adminToken()}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function patchFlag(state: FlagSnapshot): Promise<void> {
  await adminApi(`/admin/flags/${state.key}`, {
    method: 'PATCH',
    body: JSON.stringify({
      description: state.description,
      enabled: true,
      percentage: 100,
      killed: false,
    }),
  });
}

function postCheckout(payload: unknown, jwt = token): Promise<Response> {
  return fetch(`${BASE}/bookings/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(payload),
  });
}

/** свой пользователь на сценарий reject: бронь другого владельца */
async function secondUserToken(): Promise<string> {
  const email = `e2e-fraud-b-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@test.local`;
  await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бот Б' }),
  });
  const login = await api<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'e2e-secret-1' }),
  });
  return login.accessToken;
}

/** разогнать velocity: count односельных броней (срез видит их до чекаута) */
async function rampUp(sessionId: string, count: number, jwt = token): Promise<void> {
  for (let i = 0; i < count; i++) {
    await api('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        customerName: 'E2E Разгон',
        seats: [await highSeat(sessionId)],
      }),
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }
}

interface FraudDecisionRow {
  bookingId: string;
  verdict: string;
  score: number;
  reasons: string[];
  status: string;
}

let original: FlagSnapshot | undefined;
/** детектив жив? первый review-сценарий проверяет честно (fail-open = нет) */
let detectiveAlive = true;

/**
 * Сеанс ПОСЛЕДНЕГО фильма афиши: другие доменные спеки хардкодят места
 * первого фильма ('1-1', '2-2'…) — антифрод гоняет конвейер броней и
 * занимает десятки мест, с первым сеансом он бы выжил соседей (run на
 * ec6ec949: bookings.e2e 409 на чужих местах). Последний фильм никто
 * не хардкодит, а места берём с ВЕРХНИХ рядов — двойной запас.
 */
async function dedicatedSession(): Promise<E2EMovie['sessions'][number]> {
  const movies = await api<{ data: E2EMovie[] }>('/movies');
  const last = movies.data[movies.data.length - 1];
  const upcoming =
    last.sessions.find((s) => Date.parse(s.startsAt) > Date.now()) ??
    last.sessions[last.sessions.length - 1];
  return upcoming;
}

/** свободное место с верхних рядов (8→1): низ занят хардкодами соседей */
async function highSeat(sessionId: string): Promise<string> {
  const map = await api<{ occupied: string[] }>(
    `/sessions/${sessionId}/seats`,
  );
  const taken = new Set(map.occupied);
  for (let row = 8; row >= 1; row--) {
    for (let seat = 10; seat >= 1; seat--) {
      const code = `${row}-${seat}`;
      if (!taken.has(code)) return code;
    }
  }
  throw new Error(`сеанс ${sessionId}: свободных мест нет`);
}

/** сколько свободных мест с верхних рядов */
async function highSeats(
  sessionId: string,
  count: number,
): Promise<string[]> {
  const seats: string[] = [];
  for (let i = 0; i < count; i++) seats.push(await highSeat(sessionId));
  return seats;
}

beforeAll(async () => {
  await bootstrap();
  if (!available) return;
  const { flags } = await adminApi<{ flags: FlagSnapshot[] }>('/admin/flags');
  original = flags.find((f) => f.key === FLAG);
  if (!original) {
    // стенд без «Суфлёра» (k8s): раскатку включать нечем — скип всего файла
    // eslint-disable-next-line no-console
    console.warn(
      flags.length === 0
        ? 'Суфлёр на стенде отсутствует — fraud.e2e пропущен'
        : `флаг ${FLAG} не нашёлся в витрине — fraud.e2e пропущен`,
    );
    return;
  }
  await patchFlag(original);
});

afterAll(async () => {
  if (available && original) {
    // полное новое состояние: PATCH перезаписывает, не мерджит
    await adminApi(`/admin/flags/${FLAG}`, {
      method: 'PATCH',
      body: JSON.stringify({
        description: original.description,
        enabled: original.enabled,
        percentage: original.percentage,
        killed: original.killed,
      }),
    });
  }
});

describe('Антифрод «Детектив» в чекауте (e2e)', () => {
  it('allow: свежий счёт с парой броней — покупка проходит как обычно', async () => {
    if (!available || !original) return;
    const session = await dedicatedSession();

    const res = await postCheckout({
      sessionId: session.id,
      customerName: 'E2E Спокойный',
      seats: [await highSeat(session.id)],
    });
    expect(res.status).toBe(201);
    const booking = (await res.json()) as {
      id: string;
      status: string;
      fraudHold: boolean;
    };
    // оплата запущена в том же вызове; холда нет
    expect(booking.status).toBe('PENDING');
    expect(booking.fraudHold).toBe(false);

    const verdict = await waitForStatus(booking.id, 'PENDING');
    expect(['CONFIRMED', 'FAILED']).toContain(verdict.status);
  });

  it('review: холд держит оплату, approve из админки запускает платёж', async () => {
    if (!available || !original) return;
    const session = await dedicatedSession();

    // +4 брони к первой — срез увидит 5: newAccount(30)+velocity(25)=55
    await rampUp(session.id, 4);
    const res = await postCheckout({
      sessionId: session.id,
      customerName: 'E2E Подозрительный',
      seats: [await highSeat(session.id)],
    });
    expect(res.status).toBe(201);
    const booking = (await res.json()) as {
      id: string;
      status: string;
      fraudHold: boolean;
    };

    if (booking.status === 'PENDING') {
      // fail-open: детектива на стенде нет (k8s) — остальное мимо
      detectiveAlive = false;
      // eslint-disable-next-line no-console
      console.warn(
        '\n⚠️  Детектив на стенде отсутствует (чекаут прошёл без холда) — fraud.e2e: сценарии ревью/block пропущены',
      );
      return;
    }

    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.fraudHold).toBe(true);

    // владелец не обходит холд старым флоу
    const payRes = await fetch(`${BASE}/bookings/${booking.id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    expect(payRes.status).toBe(409);
    const refusal = (await payRes.json()) as { code: string };
    expect(refusal.code).toBe('fraudReview');

    // очередь ревью в витрине видит бронь с причинами
    const showcase = await adminApi<{ decisions: FraudDecisionRow[] }>(
      '/admin/fraud?status=pending_review',
    );
    const row = showcase.decisions.find((d) => d.bookingId === booking.id);
    expect(row).toMatchObject({
      verdict: 'review',
      score: 55,
      reasons: ['newAccount', 'velocity'],
      status: 'pending_review',
    });

    // решение человека: системная оплата запускается
    const resolveRes = await adminApi<{ resolved: string; booking: { status: string } }>(
      `/admin/fraud/${booking.id}/resolve`,
      { method: 'POST', body: JSON.stringify({ action: 'approve' }) },
    );
    expect(resolveRes).toMatchObject({ resolved: 'approved' });
    expect(resolveRes.booking.status).toBe('PENDING');

    const verdict = await waitForStatus(booking.id, 'PENDING');
    expect(['CONFIRMED', 'FAILED']).toContain(verdict.status);
  });

  it('review + reject: бронь гасится, место возвращается в продажу', async () => {
    if (!available || !original || !detectiveAlive) return;
    const session = await dedicatedSession();

    const jwtB = await secondUserToken();
    await rampUp(session.id, 5, jwtB);
    const seat = await highSeat(session.id);
    const res = await postCheckout(
      { sessionId: session.id, customerName: 'E2E Гость Б', seats: [seat] },
      jwtB,
    );
    expect(res.status).toBe(201);
    const booking = (await res.json()) as {
      id: string;
      status: string;
      fraudHold: boolean;
    };
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.fraudHold).toBe(true);

    const resolveRes = await adminApi<{
      resolved: string;
      booking: { status: string };
    }>(`/admin/fraud/${booking.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(resolveRes).toMatchObject({ resolved: 'rejected' });
    expect(resolveRes.booking.status).toBe('CANCELLED');

    // место снова в продаже
    const map = await api<{ occupied: string[] }>(
      `/sessions/${session.id}/seats`,
    );
    expect(map.occupied).not.toContain(seat);
  });

  it('block: конвейер броней с полрядом мест — 409 fraudBlocked, брони нет', async () => {
    if (!available || !original || !detectiveAlive) return;
    const session = await dedicatedSession();

    // догоняем до 12 броней — порог velocityHigh на 10, запас две:
    // ровно на пороге любые чужие метры (сравнение дат, гонки сидов)
    // не должны оставлять правило несработавшим
    let mine = await api<{ id: string }[]>('/bookings/my');
    await rampUp(session.id, Math.max(0, 12 - mine.length));
    mine = await api<{ id: string }[]>('/bookings/my');
    const seats = await highSeats(session.id, 6);

    const before = mine.length;
    const res = await postCheckout({
      sessionId: session.id,
      customerName: 'E2E Конвейер',
      seats,
    });
    if (res.status !== 409) {
      // диагностика в аннотацию: что именно увидел скоринг
      const booking = (await res.json()) as { id: string; status: string };
      const showcase = await adminApi<{ decisions: FraudDecisionRow[] }>(
        '/admin/fraud',
      );
      const row = showcase.decisions.find((d) => d.bookingId === booking.id);
      throw new Error(
        `block-чекаут пришёл ${res.status}: статус брони ${booking.status}, решение ${JSON.stringify(row)}`,
      );
    }
    const body = (await res.json()) as {
      code: string;
      score: number;
      reasons: string[];
    };
    expect(body).toMatchObject({
      code: 'fraudBlocked',
      reasons: ['newAccount', 'velocityHigh', 'manySeats'],
    });
    expect(body.score).toBeGreaterThanOrEqual(75);

    // бронь не создана вовсе
    const after = await api<{ id: string }[]>('/bookings/my');
    expect(after).toHaveLength(before);

    // автоматический вердикт закрыт сразу; id решения — не id брони
    // (брони нет), но правила говорят сами
    const showcase = await adminApi<{ decisions: FraudDecisionRow[] }>(
      '/admin/fraud?status=auto_blocked',
    );
    expect(showcase.decisions.length).toBeGreaterThan(0);
    expect(showcase.decisions[0].reasons).toContain('velocityHigh');
  });
});

/**
 * E2E мгновенный чекаут за флагом checkout.new_flow: раскатка тумблером
 * «Суфлёра» на живом стенде (docker compose up --build). Каркас сьюта —
 * проба health, свой e2e-пользователь на файл, api() — в ./e2e-context.
 * Если API не поднят — тесты файла тихо пропускаются с предупреждением.
 *
 * Спека меняет глобальное состояние (тумблер в «Суфлёре»): исходный
 * снимок берётся в beforeAll и возвращается в afterAll — общий стенд
 * остаётся как был даже при падении тестов. Сьют идёт с --runInBand,
 * другие доменные файлы checkout.new_flow не трогают.
 */
import {
  adminToken,
  api,
  available,
  BASE,
  bootstrap,
  E2EMovie,
  freeSeat,
  token,
  waitForStatus,
} from './e2e-context';

jest.setTimeout(30_000);

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

/** полное новое состояние тумблера: PATCH перезаписывает, не мерджит */
async function patchFlag(state: FlagSnapshot): Promise<void> {
  await adminApi(`/admin/flags/${state.key}`, {
    method: 'PATCH',
    body: JSON.stringify({
      description: state.description,
      enabled: state.enabled,
      percentage: state.percentage,
      killed: state.killed,
    }),
  });
}

function postCheckout(payload: unknown): Promise<Response> {
  return fetch(`${BASE}/bookings/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
}

let original: FlagSnapshot | undefined;

beforeAll(async () => {
  await bootstrap();
  if (!available) return;
  const { flags } = await adminApi<{ flags: FlagSnapshot[] }>('/admin/flags');
  original = flags.find((f) => f.key === FLAG);
  if (!original) {
    throw new Error(
      `флаг ${FLAG} не нашёлся в витрине — каталог должен был саморегистрироваться`,
    );
  }
});

afterAll(async () => {
  if (available && original) await patchFlag(original);
});

describe('Мгновенный чекаут за флагом checkout.new_flow (e2e)', () => {
  it('вне раскатки (0%): маршрут скрыт — 403 featureDisabled', async () => {
    if (!available || !original) return;
    await patchFlag({ ...original, enabled: true, percentage: 0, killed: false });

    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];

    const res = await postCheckout({
      sessionId: session.id,
      customerName: 'E2E Флаг-оф',
      seats: [await freeSeat(session.id)],
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      code: string;
      flag: string;
      reason: string;
    };
    expect(body).toMatchObject({ code: 'featureDisabled', flag: FLAG });
    expect(body.reason).toBeTruthy();
  });

  it('раскатка 100%: чекаут одним вызовом — PENDING и вердикт воркера', async () => {
    if (!available || !original) return;
    await patchFlag({ ...original, enabled: true, percentage: 100, killed: false });

    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    const seat = await freeSeat(session.id);

    const res = await postCheckout({
      sessionId: session.id,
      customerName: 'E2E Флаг-он',
      seats: [seat],
    });
    expect(res.status).toBe(201);
    const booking = (await res.json()) as {
      id: string;
      status: string;
      seats: string[];
    };
    // мгновенный чекаут: платёж запущен в том же вызове — не PENDING_PAYMENT
    expect(booking.status).toBe('PENDING');
    expect(booking.seats).toEqual([seat]);

    // вердикт Go-воркера по запущенному платежу (обработка 1,2–2,8 c)
    const verdict = await waitForStatus(booking.id, 'PENDING');
    expect(['CONFIRMED', 'FAILED']).toContain(verdict.status);
    expect(verdict.processedBy).toBe('go-worker-1');
  });

  it('откат к 0%: маршрут снова скрыт — 403', async () => {
    if (!available || !original) return;
    await patchFlag({ ...original, enabled: true, percentage: 0, killed: false });

    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];

    const res = await postCheckout({
      sessionId: session.id,
      customerName: 'E2E Флаг-оф-2',
      seats: [await freeSeat(session.id)],
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; flag: string };
    expect(body).toMatchObject({ code: 'featureDisabled', flag: FLAG });
  });
});

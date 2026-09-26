/**
 * E2E бонусная программа — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, available, E2EMovie } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('бонусная программа', () => {
  /** запросы за конкретного пользователя (fresh-токен в заголовке) */
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

  /** случайное свободное место — против коллизий между прогонами */
  function randomSeat(): string {
    return `${1 + Math.floor(Math.random() * 8)}-${1 + Math.floor(Math.random() * 10)}`;
  }

  it('401 без токена; свежий пользователь — пустой счёт', async () => {
    if (!available) return;
    const noAuth = await fetch(`${BASE}/bonuses/my`);
    expect(noAuth.status).toBe(401);

    const email = `e2e-bonus-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бонус' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    const account = await as<{ balance: number; transactions: unknown[] }>(
      login.accessToken,
      '/bonuses/my',
    );
    expect(account.balance).toBe(0);
    expect(account.transactions).toEqual([]);
  });

  it('409 bonusOverLimit: больше половины чека', async () => {
    if (!available) return;
    const email = `e2e-bonus-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бонус' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    const booking = await as<{ id: string; totalRub: number }>(
      login.accessToken,
      '/bookings',
      {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.id, seats: [randomSeat()] }),
      },
    );

    const refused = await fetch(`${BASE}/bookings/${booking.id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.accessToken}`,
      },
      body: JSON.stringify({ useBonuses: Math.floor(booking.totalRub / 2) + 1 }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('bonusOverLimit');
  });

  it('409 bonusInsufficient: баланса меньше запрошенного', async () => {
    if (!available) return;
    const email = `e2e-bonus-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бонус' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    const booking = await as<{ id: string; totalRub: number }>(
      login.accessToken,
      '/bookings',
      {
        method: 'POST',
        body: JSON.stringify({ sessionId: session.id, seats: [randomSeat()] }),
      },
    );

    // 1 бонус ≤ половины чека — упираемся именно в баланс
    const refused = await fetch(`${BASE}/bookings/${booking.id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.accessToken}`,
      },
      body: JSON.stringify({ useBonuses: 1 }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe('bonusInsufficient');
  });

  it('полный цикл: CONFIRMED копит кэшбэк → оплата бонусами → вердикт доначисляет', async () => {
    if (!available) return;
    const email = `e2e-bonus-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бонус' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    const jwt = login.accessToken;

    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];

    /** бронь+оплата до CONFIRMED (воркер отказывает ~10% — ретраи) */
    async function confirmedBooking(): Promise<{ id: string; totalRub: number }> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const booking = await as<{ id: string; totalRub: number; status: string }>(
          jwt,
          '/bookings',
          {
            method: 'POST',
            body: JSON.stringify({
              sessionId: session.id,
              seats: [randomSeat()],
            }),
          },
        );
        await as(jwt, `/bookings/${booking.id}/pay`, { method: 'POST' });
        for (let poll = 0; poll < 20; poll++) {
          await new Promise((r) => setTimeout(r, 700));
          const mine = await as<
            { id: string; status: string; totalRub: number }[]
          >(jwt, '/bookings/my');
          const done = mine.find((b) => b.id === booking.id);
          if (done?.status === 'CONFIRMED') return done;
          if (done?.status === 'FAILED') break; // новый заход с новой бронью
        }
      }
      throw new Error('воркер не подтвердил ни одну из 5 броней');
    }

    // первая бронь копит кэшбэк: floor(total × 5%)
    const first = await confirmedBooking();
    const cashback = Math.floor(first.totalRub * 0.05);
    expect(cashback).toBeGreaterThan(0);
    const afterFirst = await as<{ balance: number; transactions: { reason: string }[] }>(
      jwt,
      '/bonuses/my',
    );
    expect(afterFirst.balance).toBe(cashback);
    expect(afterFirst.transactions[0]).toMatchObject({
      kind: 'accrual',
      reason: 'cashback',
      amount: cashback,
    });

    // вторая — тратит часть кэшбэка (не больше половины чека)
    const spend = Math.min(Math.floor(first.totalRub / 2), cashback);
    const second = await as<{ id: string; totalRub: number }>(jwt, '/bookings', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id, seats: [randomSeat()] }),
    });
    const paid = await as<{
      totalRub: number;
      bonusSpent: number;
      status: string;
    }>(jwt, `/bookings/${second.id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ useBonuses: spend }),
    });
    expect(paid.bonusSpent).toBe(spend);
    expect(paid.totalRub).toBe(second.totalRub - spend);

    const confirmed2 = await (async () => {
      for (let poll = 0; poll < 20; poll++) {
        await new Promise((r) => setTimeout(r, 700));
        const mine = await as<{ id: string; status: string; totalRub: number }[]>(
          jwt,
          '/bookings/my',
        );
        const done = mine.find((b) => b.id === second.id);
        if (done?.status === 'CONFIRMED') return done;
        if (done?.status === 'FAILED') {
          // оплата не прошла — бонусы вернулись: проверим и это
          return done;
        }
      }
      throw new Error('вердикт второй брони не пришёл');
    })();

    const final = await as<{ balance: number }>(jwt, '/bonuses/my');
    if (confirmed2.status === 'CONFIRMED') {
      // кэшбэк с фактически оплаченной суммы
      expect(final.balance).toBe(
        cashback - spend + Math.floor((second.totalRub - spend) * 0.05),
      );
    } else {
      // FAILED вернул списанное на счёт
      expect(final.balance).toBe(cashback);
    }
  }, 120_000);
});


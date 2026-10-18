/**
 * E2E бонусная программа — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import {
  api,
  bootstrap,
  BASE,
  available,
  E2EMovie,
  freeSeat,
} from './e2e-context';

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

  /** место — из живой карты занятости (freeSeat в e2e-context):
   *  параллельные спеки бронируют на тот же сеанс, вслепую выбранные
   *  места ловили 409 placeAlreadyTaken */

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
        body: JSON.stringify({
          sessionId: session.id,
          seats: [await freeSeat(session.id)],
        }),
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

    // отказ на pay не финализирует бронь сама — место возвращаем стенду
    await as(login.accessToken, `/bookings/${booking.id}/cancel`, {
      method: 'POST',
    });
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
        body: JSON.stringify({
          sessionId: session.id,
          seats: [await freeSeat(session.id)],
        }),
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

    /** статус своей брони — из списка /bookings/my */
    async function statusOf(id: string): Promise<string | undefined> {
      const mine = await as<{ id: string; status: string }[]>(jwt, '/bookings/my');
      return mine.find((b) => b.id === id)?.status;
    }

    /**
     * Вердикт воркера по оплаченной брони. Молчание дольше окна — не
     * «потерянная» бронь: её поздний вердикт доначислил бы кэшбэк уже
     * после балансовых ассертов. Финализируем отменой, как живой
     * пользователь (reminders.e2e): cancel → ждать вердикта; вероятностный
     * REFUND_FAILED откатывает в CONFIRMED — тогда бронь подтверждена.
     */
    async function verdictOf(id: string): Promise<string> {
      const settle = async (busy: string[]): Promise<string | undefined> => {
        for (let poll = 0; poll < 20; poll++) {
          await new Promise((r) => setTimeout(r, 700));
          const status = await statusOf(id);
          if (status && !busy.includes(status)) return status;
        }
        return undefined;
      };
      const verdict = await settle(['PROCESSING']);
      if (verdict) return verdict;
      for (let attempt = 0; attempt < 2; attempt++) {
        await as(jwt, `/bookings/${id}/cancel`, { method: 'POST' }).catch(() => {});
        const settled = await settle(['PROCESSING', 'CANCELLING']);
        if (settled) return settled;
      }
      throw new Error(`бронь ${id}: вердикт не пришёл, отмена не финализировалась`);
    }

    /** бронь+оплата до CONFIRMED (воркер отказывает ~10% — ретраи
     *  с новой бронью; молчащие финализируются отменой в verdictOf) */
    async function confirmedBooking(): Promise<{ id: string; totalRub: number }> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const booking = await as<{ id: string; totalRub: number }>(jwt, '/bookings', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: session.id,
            seats: [await freeSeat(session.id)],
          }),
        });
        await as(jwt, `/bookings/${booking.id}/pay`, { method: 'POST' });
        if ((await verdictOf(booking.id)) === 'CONFIRMED') return booking;
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
      body: JSON.stringify({
        sessionId: session.id,
        seats: [await freeSeat(session.id)],
      }),
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

    const verdict2 = await verdictOf(second.id);

    const final = await as<{ balance: number }>(jwt, '/bonuses/my');
    if (verdict2 === 'CONFIRMED') {
      // кэшбэк с фактически оплаченной суммы
      expect(final.balance).toBe(
        cashback - spend + Math.floor((second.totalRub - spend) * 0.05),
      );
    } else {
      // FAILED или финализированная отменой вернули списанное на счёт
      expect(final.balance).toBe(cashback);
    }
  }, 120_000);
});


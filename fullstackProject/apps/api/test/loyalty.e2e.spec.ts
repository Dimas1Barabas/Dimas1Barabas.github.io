/**
 * E2E уровни «Киноман» (этап 38) — против живого стенда (docker compose
 * up --build / kind). Пороги стендам копеечные (LOYALTY_TIERS_RUB=100,
 * 300,900): CONFIRMED-брони быстро переводят уровень — витрина /loyalty/my
 * растёт, перк бара применяется в заказе. Каркас сьюта — ./e2e-context;
 * без стенда файл тихо пропускается с предупреждением.
 */
import { api, bootstrap, BASE, available, E2EMovie, freeSeat } from './e2e-context';

jest.setTimeout(60_000);

beforeAll(bootstrap);

interface LoyaltyMy {
  code: string;
  name: string;
  lifetimeSpentRub: number;
  perks: {
    cashbackPercent: number;
    barDiscountPercent: number;
    demandMarkupWaived: boolean;
  };
  next: { name: string; toNextRub: number; progressPercent: number } | null;
}

describe('уровни «Киноман»', () => {
  /** свой пользователь на кейс: траты копятся у одного владельца */
  async function ownToken(): Promise<string> {
    const email = `e2e-loyalty-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Уровень' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    return login.accessToken;
  }

  /** статус своей брони — из списка «моих» */
  async function statusOf(id: string, jwt: string): Promise<string | undefined> {
    const mine = await api<{ id: string; status: string }[]>('/bookings/my', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    return mine.find((b) => b.id === id)?.status;
  }

  /** вердикт воркера — как bonus.e2e: молчащую бронь финализируем
   *  отменой, вероятностный REFUND_FAILED учтён второй попыткой */
  async function verdictOf(id: string, jwt: string): Promise<string> {
    const settle = async (busy: string[]): Promise<string | undefined> => {
      for (let poll = 0; poll < 20; poll++) {
        await new Promise((r) => setTimeout(r, 700));
        const status = await statusOf(id, jwt);
        if (status && !busy.includes(status)) return status;
      }
      return undefined;
    };
    const verdict = await settle(['PENDING']);
    if (verdict) return verdict;
    for (let attempt = 0; attempt < 2; attempt++) {
      await api(`/bookings/${id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      }).catch(() => {});
      const settled = await settle(['PENDING', 'CANCELLING']);
      if (settled) return settled;
    }
    throw new Error(`бронь ${id}: вердикт не пришёл, отмена не финализировалась`);
  }

  /** копит CONFIRMED-брони одного пользователя до порога трат;
   *  возвращает фактическую сумму (воркер отказывает ~10% — ретраи) */
  async function confirmUntil(
    jwt: string,
    session: { id: string },
    targetSpent: number,
  ): Promise<number> {
    let spent = 0;
    for (let attempt = 0; attempt < 6 && spent < targetSpent; attempt++) {
      const booking = await api<{ id: string; totalRub: number }>('/bookings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          sessionId: session.id,
          seats: [await freeSeat(session.id)],
        }),
      });
      await api(`/bookings/${booking.id}/pay`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}` },
      });
      if ((await verdictOf(booking.id, jwt)) === 'CONFIRMED') {
        spent += booking.totalRub;
      }
    }
    return spent;
  }

  it('401 без токена; свежий пользователь — Новичок с прогрессом 0%', async () => {
    if (!available) return;
    const noAuth = await fetch(`${BASE}/loyalty/my`);
    expect(noAuth.status).toBe(401);

    const jwt = await ownToken();
    const fresh = await api<LoyaltyMy>('/loyalty/my', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(fresh.code).toBe('newcomer');
    expect(fresh.lifetimeSpentRub).toBe(0);
    expect(fresh.perks.barDiscountPercent).toBe(0);
    expect(fresh.perks.demandMarkupWaived).toBe(false);
    expect(fresh.perks.cashbackPercent).toBeGreaterThan(0);
    expect(fresh.next).not.toBeNull();
    expect(fresh.next!.progressPercent).toBe(0);
    expect(fresh.next!.toNextRub).toBeGreaterThan(0);
  });

  it('CONFIRMED-брони растят витрину: траты, уровень, перк бара', async () => {
    if (!available) return;
    const jwt = await ownToken();
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];

    // до первой ступени (порог стенда 100 ₽): возможно, не одна бронь
    const spent = await confirmUntil(jwt, session, 100);
    expect(spent).toBeGreaterThanOrEqual(100);

    const grown = await api<LoyaltyMy>('/loyalty/my', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(grown.lifetimeSpentRub).toBe(spent);
    expect(grown.code).not.toBe('newcomer');
    expect(grown.perks.barDiscountPercent).toBeGreaterThan(0);
    if (grown.next) {
      expect(grown.next.progressPercent).toBeGreaterThanOrEqual(0);
      expect(grown.next.progressPercent).toBeLessThanOrEqual(100);
    } else {
      expect(grown.code).toBe('legend');
    }
  }, 180_000);

  it('заказ кинобара несёт скидку уровня: итог за вычетом floor-процента', async () => {
    if (!available) return;
    const jwt = await ownToken();
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];

    // до Киномана стенда (300 ₽): скидка бара от 10%. Накопление может
    // перескочить ступень (бронь неделима) — Легенда тоже подходит
    const spent = await confirmUntil(jwt, session, 300);
    expect(spent).toBeGreaterThanOrEqual(300);

    const status = await api<LoyaltyMy>('/loyalty/my', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(['cinephile', 'legend']).toContain(status.code);
    expect(status.perks.barDiscountPercent).toBeGreaterThanOrEqual(10);

    const menu = await api<
      { id: string; priceRub: number; stock: number; soldOut: boolean }[]
    >('/bar/menu');
    const item = menu.find((i) => !i.soldOut && i.stock >= 1);
    expect(item).toBeDefined();

    const order = await api<{
      id: string;
      totalRub: number;
      loyaltyDiscountPercent: number;
      items: { priceRub: number; qty: number }[];
    }>('/bar/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ items: [{ itemId: item!.id, qty: 1 }] }),
    });
    const gross = order.items.reduce((s, i) => s + i.priceRub * i.qty, 0);
    expect(order.loyaltyDiscountPercent).toBe(status.perks.barDiscountPercent);
    expect(order.totalRub).toBe(
      gross - Math.floor((gross * order.loyaltyDiscountPercent) / 100),
    );

    // стенду возвращаем порцию: отмена NEW восстанавливает остаток
    await api(`/bar/orders/${order.id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    });
  }, 180_000);
});

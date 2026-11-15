/**
 * E2E реферальная программа — против живого стенда (docker compose up
 * --build): код приглашения хоста → регистрация друга по коду → первая
 * оплаченная бронь друга начисляет бонус обеим сторонам → вторая бронь
 * ничего не добавляет. Каркас сьюта — ./e2e-context; без стенда файл
 * тихо пропускается с предупреждением.
 */
import {
  api,
  available,
  BASE,
  bootstrap,
  E2EMovie,
  freeSeat,
  waitForStatus,
} from './e2e-context';

jest.setTimeout(60_000);

beforeAll(bootstrap);

interface ReferralsMy {
  code: string;
  bonusInviter: number;
  bonusFriend: number;
  totals: { invited: number; paid: number; earned: number };
  invited: { name: string; email: string; paid: boolean }[];
}

interface BonusMy {
  balance: number;
  transactions: { reason: string; amount: number }[];
}

describe('реферальная программа', () => {
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

  /** регистрация + вход — свежий пользователь с optional кодом приглашения */
  async function newUser(referralCode?: string): Promise<string> {
    const email = `e2e-ref-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'e2e-secret-1',
        name: 'E2E Реферал',
        ...(referralCode ? { referralCode } : {}),
      }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    return login.accessToken;
  }

  /**
   * Оплаченная CONFIRMED-бронь пользователя: вердикт воркера обычно
   * успешен, FAILED (~как в проде) — просто повторяем новой бронью,
   * места неудачной возвращаются в продажу.
   */
  async function paidBooking(jwt: string): Promise<void> {
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    for (let attempt = 0; attempt < 3; attempt++) {
      const booking = await as<{ id: string }>(jwt, '/bookings', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          seats: [await freeSeat(session.id)],
        }),
      });
      await as(jwt, `/bookings/${booking.id}/pay`, { method: 'POST' });
      const verdict = await waitForStatus(booking.id, 'PENDING');
      if (verdict.status === 'CONFIRMED') return;
    }
    throw new Error('три брони подряд не прошли оплатой — на стенде что-то не так');
  }

  it('без токена — 401; свежий пользователь получает код и пустую витрину', async () => {
    if (!available) return;
    const noAuth = await fetch(`${BASE}/referrals/my`);
    expect(noAuth.status).toBe(401);

    const jwt = await newUser();
    const my = await as<ReferralsMy>(jwt, '/referrals/my');
    expect(my.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(my.bonusInviter).toBe(300);
    expect(my.bonusFriend).toBe(100);
    expect(my.totals).toEqual({ invited: 0, paid: 0, earned: 0 });
    expect(my.invited).toEqual([]);
  });

  it('опечатка в коде — 400 referralCodeUnknown', async () => {
    if (!available) return;
    const res = await fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `e2e-ref-bad-${Date.now()}@test.local`,
        password: 'e2e-secret-1',
        name: 'E2E Опечатка',
        referralCode: 'NOPE1234',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      'referralCodeUnknown',
    );
  });

  it('полный цикл: друг по коду оплатил первую бронь — бонус обеим сторонам, вторая ничего не добавляет', async () => {
    if (!available) return;
    // host — e2e-пользователь этого файла (bootstrap)
    const hostMy = await api<ReferralsMy>('/referrals/my');
    const friend = await newUser(hostMy.code);

    // до оплаты: друг в витрине, paid=false
    const before = await api<ReferralsMy>('/referrals/my');
    expect(before.totals).toEqual({ invited: 1, paid: 0, earned: 0 });
    expect(before.invited[0]).toMatchObject({ paid: false });
    // email замаскирован: первая буква и домен
    expect(before.invited[0].email).toMatch(/^.?\*\*\*@test\.local$/);

    await paidBooking(friend);

    // другу — welcome, хосту — referral (кэшбэк другу тоже был)
    const friendAccount = await as<BonusMy>(friend, '/bonuses/my');
    const welcome = friendAccount.transactions.filter(
      (t) => t.reason === 'referral_welcome',
    );
    expect(welcome).toHaveLength(1);
    expect(welcome[0].amount).toBe(100);

    const hostAfterFirst = await api<ReferralsMy>('/referrals/my');
    expect(hostAfterFirst.totals).toEqual({ invited: 1, paid: 1, earned: 300 });
    expect(hostAfterFirst.invited[0].paid).toBe(true);
    const hostAccount = await api<BonusMy>('/bonuses/my');
    expect(
      hostAccount.transactions.filter((t) => t.reason === 'referral'),
    ).toHaveLength(1);

    // вторая оплаченная бронь друга — награда уже израсходована
    await paidBooking(friend);
    const hostAfterSecond = await api<ReferralsMy>('/referrals/my');
    expect(hostAfterSecond.totals).toEqual({ invited: 1, paid: 1, earned: 300 });
    const friendSecond = await as<BonusMy>(friend, '/bonuses/my');
    expect(
      friendSecond.transactions.filter((t) => t.reason === 'referral_welcome'),
    ).toHaveLength(1);
  });
});

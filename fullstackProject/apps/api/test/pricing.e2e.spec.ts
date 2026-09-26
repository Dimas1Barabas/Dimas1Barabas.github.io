/**
 * E2E Тарификатор: цена сеанса (динамическое ценообразование) — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, available, E2EMovie } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('Тарификатор: цена сеанса (динамическое ценообразование)', () => {
  const PRICING = process.env.E2E_PRICING_URL ?? 'http://localhost:18089';

  /** ответ витрины GET /sessions/:id/price */
  type E2EQuote = {
    basePriceRub: number;
    priceRub: number;
    factors: { code: string; percent: number }[];
    dynamic: boolean;
  };

  /** витрина Тарификатора жива? без неё ценовые проверки пропускаются */
  async function pricingUp(): Promise<boolean> {
    const health = await fetch(`${PRICING}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    return !!health?.ok;
  }

  /** вход админом посева — создаёт сеанс под прогон */
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
    return ((await login.json()) as { accessToken: string }).accessToken;
  }

  /** свежий сеанс: час сеанса не контролируем — сверяем инварианты, не набор факторов */
  async function freshSession(inMinutes = 60): Promise<string> {
    const admin = await adminToken();
    const res = await fetch(`${BASE}/movies`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin}`,
      },
      body: JSON.stringify({
        title: `E2E Тарификатор ${Date.now()}`,
        description: 'Сеанс под динамическую цену',
        genre: 'e2e',
        genreIcon: '🏷️',
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

  async function priceOf(sessionId: string): Promise<E2EQuote> {
    const res = await fetch(`${BASE}/sessions/${sessionId}/price`);
    expect(res.status).toBe(200);
    return (await res.json()) as E2EQuote;
  }

  /** проекция спроса в витрине Тарификатора: сколько мест держит сеанс */
  async function demandOf(sessionId: string): Promise<number> {
    const res = await fetch(`${PRICING}/demand`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} у витрины спроса`);
    const body = (await res.json()) as {
      demand: { sessionId: string; occupied: number }[];
    };
    return body.demand.find((d) => d.sessionId === sessionId)?.occupied ?? 0;
  }

  it('витрина цены: раскладка факторов, dynamic, история квотов; 404', async () => {
    if (!available) return;
    if (!(await pricingUp())) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n⚠️  pricing (${PRICING}) недоступен — e2e Тарификатора пропущен\n`,
      );
      return;
    }

    const sessionId = await freshSession();
    const quote = await priceOf(sessionId);

    expect(quote.dynamic).toBe(true);
    expect(quote.basePriceRub).toBe(350);
    expect(quote.priceRub).toBeGreaterThan(0);
    expect(quote.priceRub % 10).toBe(0); // монеты из афиши не возвращаются
    const codes = new Set([
      'morning',
      'evening',
      'weekend',
      'demand_low',
      'demand_high',
      'demand_full',
    ]);
    for (const f of quote.factors) {
      expect(codes.has(f.code)).toBe(true);
      expect(Math.abs(f.percent)).toBeLessThanOrEqual(25);
    }

    // история квотов: проведённый расчёт лёг в витрину сервиса
    let row: { sessionId: string; priceRub: number } | undefined;
    for (let attempt = 0; attempt < 5 && !row; attempt++) {
      const res = await fetch(`${PRICING}/prices`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (res?.ok) {
        const body = (await res.json()) as {
          quotes: { sessionId: string; priceRub: number }[];
        };
        row = body.quotes.find((q) => q.sessionId === sessionId);
      }
      if (!row) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(row?.priceRub).toBe(quote.priceRub);

    // незнакомый сеанс — обычный 404 витрины, не 5xx
    const miss = await fetch(
      `${BASE}/sessions/00000000-0000-0000-0000-000000000000/price`,
    );
    expect(miss.status).toBe(404);
  }, 60_000);

  it('полный цикл: чек фиксирует квот момента брони, спрос видит резерв', async () => {
    if (!available) return;
    if (!(await pricingUp())) return;

    const sessionId = await freshSession();
    const before = await priceOf(sessionId); // цена ДО брони — уйдёт в чек

    const email = `e2e-prc-${Date.now()}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Цена' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });

    // create() спрашивает квот ДО занятия мест — чек = цена × места
    const booking = await fetch(`${BASE}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.accessToken}`,
      },
      body: JSON.stringify({
        sessionId,
        customerName: 'E2E Тарификатор',
        seats: ['7-1', '7-2'],
      }),
    });
    expect(booking.status).toBe(201);
    const created = (await booking.json()) as { totalRub: number };
    expect(created.totalRub).toBe(before.priceRub * 2);

    // wait-событие брони довезло резерв до проекции спроса
    let occupied = 0;
    for (let attempt = 0; attempt < 10 && occupied < 2; attempt++) {
      occupied = await demandOf(sessionId);
      if (occupied < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    expect(occupied).toBeGreaterThanOrEqual(2);

    // цена продолжает считаться: кратность и динамичность не сломаны
    const after = await priceOf(sessionId);
    expect(after.dynamic).toBe(true);
    expect(after.priceRub % 10).toBe(0);
  }, 90_000);
});


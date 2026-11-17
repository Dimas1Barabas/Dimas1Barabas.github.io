/**
 * E2E кинобар (этап 32) — против живого стенда (docker compose up
 * --build): заказ через API → очередь на витрине Бармена /bar → кнопки
 * «в работу»/«готов»/«выдан» → статусы возвращаются событиями в
 * bar_orders («мои заказы») → «письмо» о готовности пишет
 * notification-service. Отмена возвращает порции на склад, гонка за
 * последнюю воду — честный 409. Каркас сьюта — ./e2e-context; без
 * стенда или Бармена файл тихо пропускается с предупреждением.
 */
import {
  api,
  available,
  BASE,
  bootstrap,
  E2EMovie,
} from './e2e-context';

jest.setTimeout(120_000);

beforeAll(bootstrap);

interface BarItemJson {
  id: string;
  slug: string;
  name: string;
  stock: number;
  soldOut: boolean;
  priceRub: number;
}

interface BarOrderJson {
  id: string;
  status: 'NEW' | 'PREPARING' | 'READY' | 'PICKED_UP' | 'CANCELLED';
  sessionId: string | null;
  hall: string | null;
  totalRub: number;
  items: { itemId: string; name: string; priceRub: number; qty: number }[];
}

/** доска Бармена: колонки очереди */
interface BoardJson {
  new: { orderId: string }[];
  preparing: { orderId: string }[];
  ready: { orderId: string }[];
  recent: { orderId: string; status: string }[];
}

interface NotificationJson {
  id: string;
  bookingId: string; // для bar_ready — email адресата
  kind: string;
  title: string;
}

describe('Кинобар: заказ сквозняком через Бармена', () => {
  const BARMAN = process.env.E2E_BARMAN_URL ?? 'http://localhost:18097';
  const NOTIF = process.env.E2E_NOTIF_URL ?? 'http://localhost:18082';

  /** витрина Бармена жива? нет — сьют скипается (стенд без сервиса) */
  async function barmanAlive(): Promise<boolean> {
    const res = await fetch(`${BARMAN}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    return !!res && res.ok;
  }

  async function board(): Promise<BoardJson> {
    const res = await fetch(`${BARMAN}/bar`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`витрина Бармена: HTTP ${res.status}`);
    return (await res.json()) as BoardJson;
  }

  /** кнопка экрана бара: «в работу» / «готов» / «выдан» */
  async function press(orderId: string, action: string): Promise<void> {
    const res = await fetch(`${BARMAN}/bar/orders/${orderId}/${action}`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      throw new Error(`кнопка ${action}: HTTP ${res.status}: ${await res.text()}`);
    }
  }

  /** свой e2e-зритель с известным email — письмо готовности ищется точно */
  async function newUser(): Promise<{ jwt: string; email: string }> {
    const email = `e2e-bar-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@test.local`;
    await api('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1', name: 'E2E Бар' }),
    });
    const login = await api<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'e2e-secret-1' }),
    });
    return { jwt: login.accessToken, email };
  }

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

  /** ждём статус заказа в «моих» (статусы едет от Бармена событиями) */
  async function waitForOrderStatus(
    jwt: string,
    orderId: string,
    status: string,
  ): Promise<BarOrderJson> {
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const mine = await as<BarOrderJson[]>(jwt, '/bar/orders/my');
      const order = mine.find((o) => o.id === orderId);
      if (order && order.status === status) return order;
    }
    throw new Error(`заказ ${orderId} не пришёл в статус ${status}`);
  }

  /** колонка доски ждёт orderId (Курьер везёт created ~секунду) */
  async function waitForColumn(
    column: 'new' | 'preparing' | 'ready' | 'recent',
    orderId: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const b = await board();
      if (b[column].some((o) => o.orderId === orderId)) return;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    throw new Error(`заказ ${orderId} не появился в колонке ${column}`);
  }

  async function menu(): Promise<BarItemJson[]> {
    return api<BarItemJson[]>('/bar/menu');
  }

  const bySlug = (items: BarItemJson[], slug: string): BarItemJson => {
    const found = items.find((i) => i.slug === slug);
    if (!found) throw new Error(`нет позиции ${slug} в каталоге стенда`);
    return found;
  };

  it('меню публично: каталог посеян, дефицит воды честно виден', async () => {
    if (!available) return;
    const items = await menu();
    expect(items.length).toBeGreaterThanOrEqual(9);
    expect(bySlug(items, 'water-sparkling').name).toContain('Вода');
  });

  it('полный цикл: заказ → Бармен готовит → письмо → выдан; статус в «моих»', async () => {
    if (!available) return;
    if (!(await barmanAlive())) {
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Бармен недоступен на', BARMAN, '— e2e бара пропущен');
      return;
    }

    const { jwt, email } = await newUser();
    const items = await menu();
    const popcorn = bySlug(items, 'popcorn-salted');
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];

    // оформить к сеансу: NEW, снимки цен, подсказка зала
    const order = await as<BarOrderJson>(jwt, '/bar/orders', {
      method: 'POST',
      body: JSON.stringify({ items: [{ itemId: popcorn.id, qty: 2 }], sessionId: session.id }),
    });
    expect(order.status).toBe('NEW');
    expect(order.totalRub).toBe(popcorn.priceRub * 2);
    expect(order.hall).toBe(session.hall);
    expect(order.items[0].name).toBe(popcorn.name);

    // очередь Бармена приняла (Курьер вёз outbox-событие)
    await waitForColumn('new', order.id);

    // «взять в работу» — статус вернётся событием в bar_orders
    await press(order.id, 'start');
    await waitForOrderStatus(jwt, order.id, 'PREPARING');
    await waitForColumn('preparing', order.id);

    // «готов» — письмо адресату пишет notification-service
    await press(order.id, 'ready');
    await waitForOrderStatus(jwt, order.id, 'READY');

    let letter: NotificationJson | undefined;
    for (let attempt = 0; attempt < 20 && !letter; attempt++) {
      const res = await fetch(
        `${NOTIF}/notifications?bookingId=${encodeURIComponent(email)}&limit=10`,
        { signal: AbortSignal.timeout(3000) },
      ).catch(() => null);
      if (res && res.ok) {
        const body = (await res.json()) as { items: NotificationJson[] };
        letter = body.items.find((l) => l.kind === 'bar_ready');
      }
      if (!letter) await new Promise((resolve) => setTimeout(resolve, 700));
    }
    expect(letter).toBeDefined();
    expect(letter!.title).toBe('Заказ в кинобаре готов');

    // «выдан» — терминальный статус
    await press(order.id, 'pickup');
    await waitForOrderStatus(jwt, order.id, 'PICKED_UP');

    // выданный заказ отменить нельзя — 409
    const cancelRes = await fetch(`${BASE}/bar/orders/${order.id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(cancelRes.status).toBe(409);
  });

  it('гонка за последнюю воду: 409 с честным остатком, отмена возвращает порции', async () => {
    if (!available) return;
    if (!(await barmanAlive())) return;

    const { jwt } = await newUser();
    const items = await menu();
    const water = bySlug(items, 'water-sparkling');

    // забрать весь остаток
    const takeAll = await as<BarOrderJson>(jwt, '/bar/orders', {
      method: 'POST',
      body: JSON.stringify({ items: [{ itemId: water.id, qty: water.stock }] }),
    });
    expect(takeAll.status).toBe('NEW');
    await waitForColumn('new', takeAll.id);

    // вода кончилась: витрина честная, второй заказ — 409
    const soldOut = bySlug(await menu(), 'water-sparkling');
    expect(soldOut.stock).toBe(0);
    expect(soldOut.soldOut).toBe(true);
    const refused = await fetch(`${BASE}/bar/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ items: [{ itemId: water.id, qty: 1 }] }),
    });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('Вода газированная 0,5 л');

    // отмена NEW возвращает порции и убирает заказ из очереди Бармена
    const cancelled = await as<BarOrderJson>(jwt, `/bar/orders/${takeAll.id}/cancel`, {
      method: 'POST',
    });
    expect(cancelled.status).toBe('CANCELLED');
    expect(bySlug(await menu(), 'water-sparkling').stock).toBe(water.stock);
    await waitForColumn('recent', takeAll.id);

    // повторная отмена — 409
    const again = await fetch(`${BASE}/bar/orders/${takeAll.id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(again.status).toBe(409);
  });

  it('негативы оформления: дубль позиции 400, несуществующий сеанс 404', async () => {
    if (!available) return;
    const { jwt } = await newUser();
    const cola = bySlug(await menu(), 'cola-05');

    const dup = await fetch(`${BASE}/bar/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        items: [
          { itemId: cola.id, qty: 1 },
          { itemId: cola.id, qty: 2 },
        ],
      }),
    });
    expect(dup.status).toBe(400);

    const noSession = await fetch(`${BASE}/bar/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        items: [{ itemId: cola.id, qty: 1 }],
        sessionId: '00000000-0000-4000-8000-00000000dead',
      }),
    });
    expect(noSession.status).toBe(404);
  });
});

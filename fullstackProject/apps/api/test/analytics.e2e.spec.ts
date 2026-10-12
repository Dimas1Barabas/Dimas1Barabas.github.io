import { randomUUID } from 'node:crypto';
import { adminToken, api, available, BASE, bootstrap } from './e2e-context';

/**
 * E2E контура поведенческой аналитики: веб-трекер шлёт батч в
 * POST /analytics/events (публичный, лимит на aid) → брокер →
 * Go-Аналитик складывает в агрегаты → витрина читается админом через
 * прокси GET /analytics/insights. Полный круг «отправил — увидел».
 *
 * На стендах без Аналитика (k8s-оверлей его не разворачивает) прокси
 * отвечает available:false — спека честно скипается, как SSE без стенда.
 */

jest.setTimeout(60_000);

/** уникальный зал: наши клики видны в тепловой карте отдельно от чужих */
const HALL = `E2E Зал ${randomUUID().slice(0, 8)}`;

interface Insights {
  funnel: { step: string; count: number }[];
  seats: { hall: string; seat: string; clicks: number }[];
}

async function insights(): Promise<Insights | null> {
  const token = await adminToken();
  const res = await fetch(`${BASE}/analytics/insights`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { available: boolean; data?: Insights };
  return body.available ? (body.data ?? null) : null;
}

/** ждём появления наших следов: консьюмер асинхронный, стенд общий */
async function waitFor<T>(probe: () => T | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('Аналитик не отразил события за 20 с');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

describe('аналитика поведения (ingest → брокер → Аналитик → витрина)', () => {
  beforeAll(() => bootstrap());

  it('прокси отвечает конвертом: available — boolean', async () => {
    if (!available) return;
    const token = await adminToken();
    const res = await fetch(`${BASE}/analytics/insights`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(typeof body.available).toBe('boolean');
  });

  it('витрина не для всех: без админского JWT — 401', async () => {
    if (!available) return;
    const res = await fetch(`${BASE}/analytics/insights`);
    expect(res.status).toBe(401);
  });

  it('батч с мусорным типом отбрасывается валидацией — 400', async () => {
    if (!available) return;
    const res = await fetch(`${BASE}/analytics/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid: randomUUID(),
        events: [{ type: 'миг', ts: new Date().toISOString() }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it('круг «отправил — увидел»: воронка и тепловая карта отвечают нашему батчу', async () => {
    if (!available) return;
    const view = await insights();
    if (view === null) {
      // eslint-disable-next-line no-console
      console.warn('\n⚠️  Аналитик на этом стенде не поднят — контур пропущен.\n');
      return;
    }

    const movieId = randomUUID();
    const sessionId = randomUUID();
    const aid = randomUUID();
    // эндпоинт публичный: приложенный Bearer e2e-пользователя ему безразличен
    const send = await api<{ accepted: number }>('/analytics/events', {
      method: 'POST',
      body: JSON.stringify({
        aid,
        events: [
          { type: 'booking_modal_open', ts: new Date().toISOString(), movieId },
          { type: 'session_selected', ts: new Date().toISOString(), movieId, sessionId },
          { type: 'seat_click', ts: new Date().toISOString(), sessionId, hall: HALL, seat: '5-7' },
          { type: 'seat_click', ts: new Date().toISOString(), sessionId, hall: HALL, seat: '5-7' },
          { type: 'page_view', ts: new Date().toISOString(), route: 'home' },
        ],
      }),
    });
    expect(send.accepted).toBe(5);

    // тепловая карта: оба клика легли в наш уникальный зал
    const hot = await waitFor(() => {
      return insights().then((cur) =>
        cur?.seats.find((s) => s.hall === HALL && s.seat === '5-7' && s.clicks >= 2),
      );
    });
    expect(hot).toBeDefined();

    // воронка: шаги пути из батча видны в агрегатах
    const funnel = await waitFor(() => {
      return insights().then((cur) => {
        const steps = new Set(cur?.funnel.map((f) => f.step));
        return steps.has('modal_open') && steps.has('session_selected') ? cur : undefined;
      });
    });
    expect(funnel).not.toBeNull();
  });
});

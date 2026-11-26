/**
 * E2E вебхуков «Почтальона» (этап 39) — против живого стенда (docker
 * compose up --build). Подписываемся партнёром (мок partnerhooks:8103)
 * на событие брони, оформляем бронь — конверт доходит до мока с
 * HMAC-подписью, которую спека проверяет тем же алгоритмом, что и
 * настоящий партнёр. Затем гоним доставку в DLQ отказами приёмника
 * (chaos-ручка мока) и возвращаем перепосылкой из витрины. Каркас
 * сьюта — ./e2e-context; без стенда файл тихо пропускается с
 * предупреждением (норма для k8s-стенда, где Почтальона нет).
 */
import { createHmac } from 'node:crypto';
import { api, bootstrap, available, E2EMovie, freeSeat } from './e2e-context';

jest.setTimeout(150_000);

beforeAll(bootstrap);

/** витрина Почтальона и мок партнёра — публикуются на хост стенда */
const POSTMAN = process.env.E2E_POSTMAN_URL ?? 'http://localhost:18102';
const PARTNER = process.env.E2E_PARTNER_URL ?? 'http://localhost:18103';

/** подпись партнёра: sha256=hex(HMAC-SHA256(secret, "<unix>.<тело>")) */
function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')}`;
}

/** сторонний fetch без авторизации e2e-пользователя */
async function raw<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface InboxEntry {
  body: string;
  signature: string | null;
  timestamp: string | null;
  event: string | null;
  delivery: string | null;
  receivedAt: string;
}

interface PartnerStats {
  mode: string;
  stats: { sink: number; sinkFailed: number };
  inbox: InboxEntry[];
}

/** опрос мока до появления конверта с deliveryId (или таймаута) */
async function untilInBox(
  deliveryId: string | null,
  event: string,
): Promise<InboxEntry> {
  for (let poll = 0; poll < 60; poll++) {
    const stats = await raw<PartnerStats>(`${PARTNER}/__stats`);
    const hit = stats.inbox.find(
      (e) =>
        (deliveryId === null || e.delivery === deliveryId) &&
        e.event === event,
    );
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`конверт ${event} не дошёл до партнёра за 60 с`);
}

/** опрос витрины до статуса доставки */
async function untilStatus(
  deliveryId: string,
  status: string,
): Promise<void> {
  for (let poll = 0; poll < 60; poll++) {
    const page = await raw<{
      deliveries: { id: string; status: string }[];
    }>(`${POSTMAN}/deliveries?limit=100`);
    const d = page.deliveries.find((x) => x.id === deliveryId);
    if (d && d.status === status) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`доставка ${deliveryId} не стала ${status} за 60 с`);
}

/** оплаченная бронь: booking.created выходит из транзакции pay —
 *  детерминированно, без вероятностных вердиктов воркера */
async function paidBooking(): Promise<string> {
  const movies = await api<{ data: E2EMovie[] }>('/movies');
  const session = movies.data[0].sessions[0];
  const booking = await api<{ id: string }>('/bookings', {
    method: 'POST',
    body: JSON.stringify({ sessionId: session.id, seats: [await freeSeat(session.id)] }),
  });
  await api(`/bookings/${booking.id}/pay`, { method: 'POST' });
  return booking.id;
}

describe('webhooks «Почтальона»', () => {
  it('подписка партнёра получает booking.created с честной HMAC-подписью', async () => {
    if (!available) return;

    // Почтальона или мока нет (k8s-стенд) — тихо пропускаем
    const up = await fetch(`${POSTMAN}/health`).catch(() => null);
    const partnerUp = await fetch(`${PARTNER}/health`).catch(() => null);
    if (!up?.ok || !partnerUp?.ok) {
      // eslint-disable-next-line no-console
      console.warn(
        '\n⚠️  Почтальон/партнёр недоступны — e2e вебхуков пропущен.',
      );
      return;
    }
    await raw(`${PARTNER}/__chaos`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'ok' }),
    });

    // подписка: секрет показывают один раз — здесь
    const sub = await raw<{
      id: string;
      secret: string;
    }>(`${POSTMAN}/subscriptions`, {
      method: 'POST',
      body: JSON.stringify({
        url: 'http://partnerhooks:8103/sink',
        events: ['booking.created'],
      }),
    });
    expect(sub.id).toMatch(/^whsub_/);
    expect(sub.secret).toMatch(/^whsec_/);

    // в списке секрет — только маской
    const list = await raw<{
      subscriptions: { id: string; secret: string }[];
    }>(`${POSTMAN}/subscriptions`);
    const masked = list.subscriptions.find((s) => s.id === sub.id);
    expect(masked?.secret).not.toBe(sub.secret);

    // бронь оплачена → событие → конверт у партнёра
    const bookingId = await paidBooking();
    const entry = await untilInBox(null, 'booking.created');

    // подпись честная: тот же HMAC, что у настоящего партнёра
    expect(entry.signature).toBe(sign(sub.secret, entry.timestamp!, entry.body));

    // конверт несёт наше событие
    const envelope = JSON.parse(entry.body) as {
      deliveryId: string;
      subscriptionId: string;
      type: string;
      data: { bookingId: string };
    };
    expect(envelope.type).toBe('booking.created');
    expect(envelope.subscriptionId).toBe(sub.id);
    expect(envelope.data.bookingId).toBe(bookingId);
    expect(envelope.deliveryId).toBe(entry.delivery);

    // витрина видит доставку доставленной
    await untilStatus(envelope.deliveryId, 'delivered');
  }, 120_000);

  it('отказы приёмника гонят доставку в DLQ; перепосылка довозит', async () => {
    if (!available) return;
    const up = await fetch(`${POSTMAN}/health`).catch(() => null);
    const partnerUp = await fetch(`${PARTNER}/health`).catch(() => null);
    if (!up?.ok || !partnerUp?.ok) return;

    // приёмник пятисотит: доставки копят попытки и умирают. Своя
    // подписка на кейс — чтобы не путать доставки с первым тестом
    const sub = await raw<{ id: string }>(`${POSTMAN}/subscriptions`, {
      method: 'POST',
      body: JSON.stringify({
        url: 'http://partnerhooks:8103/sink',
        events: ['booking.created'],
      }),
    });
    await raw(`${PARTNER}/__chaos`, {
      method: 'POST',
      body: JSON.stringify({ mode: '500' }),
    });
    const bookingId = await paidBooking();

    // ждём свою доставку и её смерть в DLQ
    let deliveryId = '';
    for (let poll = 0; poll < 60 && !deliveryId; poll++) {
      const page = await raw<{
        deliveries: { id: string; subscriptionId: string }[];
      }>(`${POSTMAN}/deliveries?limit=100`);
      const mine = page.deliveries.find(
        (d) => d.subscriptionId === sub.id,
      );
      if (mine) deliveryId = mine.id;
      else await new Promise((r) => setTimeout(r, 1000));
    }
    expect(deliveryId).not.toBe('');
    await untilStatus(deliveryId, 'dead');

    // DLQ видна в витрине с итогами
    const dead = await raw<{
      deliveries: { id: string; lastError: string }[];
      counts: Record<string, number>;
    }>(`${POSTMAN}/deliveries?status=dead`);
    expect(dead.counts.dead).toBeGreaterThanOrEqual(1);

    // чиним приёмник и перепосылаем: доставка доходит с первой попытки
    await raw(`${PARTNER}/__chaos`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'ok' }),
    });
    const revived = await raw<{ id: string; status: string }>(
      `${POSTMAN}/deliveries/${deliveryId}/replay`,
      { method: 'POST' },
    );
    expect(revived.status).toBe('queued');

    const entry = await untilInBox(deliveryId, 'booking.created');
    expect(JSON.parse(entry.body).data.bookingId).toBe(bookingId);
    await untilStatus(deliveryId, 'delivered');
  }, 120_000);
});

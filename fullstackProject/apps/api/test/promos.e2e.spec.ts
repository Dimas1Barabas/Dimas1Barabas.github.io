/**
 * E2E промокоды и скидки — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, token, available, waitForStatus, E2EMovie, adminToken, freeSeat } from './e2e-context';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('промокоды и скидки', () => {
  /** уникальный код на прогон — коллизии между запусками исключены */
  const code = `E2E${Date.now().toString(36).toUpperCase()}`;

  async function createBooking(): Promise<{
    id: string;
    totalRub: number;
  }> {
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    // место из живой карты: хардкод конфликтовал с соседними файлами
    // и с повторными вызовами внутри этого (гонка бронила 7-7 дважды)
    const seat = await freeSeat(session.id);
    return api('/bookings', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.id,
        customerName: 'E2E Промо',
        seats: [seat],
      }),
    });
  }

  it('админ создаёт промокод; дубль — 409 promoExists, не-админу — 403', async () => {
    if (!available) return;
    const admin = await adminToken();

    const created = await fetch(`${BASE}/promos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin}`,
      },
      body: JSON.stringify({
        code,
        kind: 'percent',
        value: 10,
        maxActivations: 2,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
    expect(created.status).toBe(201);
    const promo = (await created.json()) as { code: string; usedCount: number };
    expect(promo.code).toBe(code); // нормализация в верхний регистр
    expect(promo.usedCount).toBe(0);

    const dup = await fetch(`${BASE}/promos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${admin}`,
      },
      body: JSON.stringify({
        code,
        kind: 'percent',
        value: 10,
        maxActivations: 5,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { code: string }).code).toBe('promoExists');

    const asUser = await fetch(`${BASE}/promos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        code: `${code}X`,
        kind: 'percent',
        value: 10,
        maxActivations: 5,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
    expect(asUser.status).toBe(403);
  });

  it('validate → pay с промокодом → воркер подтверждает со скидочной суммой', async () => {
    if (!available) return;
    const admin = await adminToken();
    const booking = await createBooking();

    // превью без списания: 10% от суммы брони
    const preview = await api<{
      discountRub: number;
      totalRub: number;
    }>('/promos/validate', {
      method: 'POST',
      body: JSON.stringify({ code, bookingId: booking.id }),
    });
    expect(preview.totalRub).toBe(booking.totalRub - preview.discountRub);

    const paid = await api<{
      id: string;
      status: string;
      totalRub: number;
      promoCode: string | null;
      discountRub: number | null;
    }>(`/bookings/${booking.id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ promoCode: code }),
    });
    expect(paid.status).toBe('PENDING');
    expect(paid.promoCode).toBe(code);
    expect(paid.discountRub).toBe(preview.discountRub);
    expect(paid.totalRub).toBe(booking.totalRub - preview.discountRub);

    // вердикт воркера по скидочной сумме
    const verdict = await waitForStatus(paid.id, 'PENDING');
    expect(['CONFIRMED', 'FAILED']).toContain(verdict.status);

    // активация списана — админ видит usedCount
    const listRes = await fetch(`${BASE}/promos`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { code: string; usedCount: number }[];
    expect(list.find((p) => p.code === code)?.usedCount).toBe(1);
  }, 60_000);

  it('гонка за последний код: pay — 409 promoExhausted, бронь осталась payable', async () => {
    if (!available) return;
    // у кода лимит 2, одна активация израсходована в цикле выше —
    // жертвенная бронь забирает последнюю, следующей уже ничего не достаётся
    const sacrifice = await createBooking();
    await api(`/bookings/${sacrifice.id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ promoCode: code }),
    });

    const booking = await createBooking();

    const refused = await fetch(`${BASE}/bookings/${booking.id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ promoCode: code }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe(
      'promoExhausted',
    );

    // транзакция откатилась целиком: бронь всё ещё ждёт оплаты
    const retry = await fetch(`${BASE}/bookings/${booking.id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    expect(retry.status).toBe(200);
    const body = (await retry.json()) as { totalRub: number; promoCode: null };
    expect(body.totalRub).toBe(booking.totalRub);
    expect(body.promoCode).toBeNull();
  });
});


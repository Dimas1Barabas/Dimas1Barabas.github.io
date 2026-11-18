/**
 * E2E гифт-сертификаты — против живого стенда (docker compose up --build):
 * покупка → активация → частичные списания в оплатах → исчерпание 409 →
 * отмена подтверждённой брони возвращает деньги на карту. Каркас сьюта —
 * ./e2e-context; без стенда файл тихо пропускается с предупреждением.
 */
import {
  api,
  available,
  BASE,
  bootstrap,
  E2EMovie,
  freeSeat,
  token,
  waitForStatus,
} from './e2e-context';

jest.setTimeout(120_000);

beforeAll(bootstrap);

interface GiftDto {
  code: string;
  nominalRub: number;
  remainingRub: number;
  status: string;
}

interface GiftsMy {
  totals: { availableRub: number; cards: number; given: number };
}

interface BookingDto {
  id: string;
  totalRub: number;
  giftCode: string | null;
  giftSpent: number | null;
  status: string;
}

/** оплаченная CONFIRMATED-бронь на 1 место (вердикт обычно успешный;
 *  FAILED — просто повторяем новой бронью, места вернулись в продажу) */
async function paidBooking(giftCode: string): Promise<BookingDto> {
  const movies = await api<{ data: E2EMovie[] }>('/movies');
  const session = movies.data[0].sessions[0];
  for (let attempt = 0; attempt < 3; attempt++) {
    const seat = await freeSeat(session.id);
    const raw = await api<BookingDto>('/bookings', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id, seats: [seat] }),
    });
    const paid = await api<BookingDto>(`/bookings/${raw.id}/pay`, {
      method: 'POST',
      body: JSON.stringify({ giftCode }),
    });
    const verdict = await waitForStatus(paid.id, 'PENDING');
    if (verdict.status === 'CONFIRMED') {
      // totalRub ответа pay — уже финальный (после гифта); чек брони
      // до списания = финал + giftSpent
      return paid;
    }
    void raw;
  }
  throw new Error('три попытки — все платежи FAILED');
}

describe('гифт-сертификаты: покупка → трата → возврат', () => {
  it('купить → активировать → списать частями → исчерпать 409', async () => {
    if (!available) return;

    // номинал на несколько частичных трат: чек одного места меньше номинала
    const gift = await api<GiftDto>('/gifts', {
      method: 'POST',
      body: JSON.stringify({ nominalRub: 800 }),
    });
    expect(gift).toMatchObject({
      nominalRub: 800,
      remainingRub: 800,
      status: 'purchased',
    });

    // регистр и обводки не важны — нормализация на сервере
    const activated = await api<GiftDto>('/gifts/activate', {
      method: 'POST',
      body: JSON.stringify({ code: `  ${gift.code.toLowerCase()} ` }),
    });
    expect(activated).toMatchObject({ status: 'active', remainingRub: 800 });

    // тратa №1: карта закрывает весь чек одного места (номинал больше)
    const first = await paidBooking(activated.code);
    const spent1 = Math.min(800, first.totalRub + (first.giftSpent ?? 0));
    expect(first.giftCode).toBe(activated.code);
    expect(first.giftSpent).toBe(spent1);

    const afterFirst = await api<GiftsMy>('/gifts/my');
    expect(afterFirst.totals.availableRub).toBe(800 - spent1);

    // добиваем карту до нуля: каждый чек списывает min(остаток, чек)
    let guard = 0;
    while (
      (await api<GiftsMy>('/gifts/my')).totals.availableRub > 0 &&
      guard++ < 10
    ) {
      await paidBooking(activated.code);
    }
    expect((await api<GiftsMy>('/gifts/my')).totals.availableRub).toBe(0);

    // исчерпанная карта отклоняет новую оплату — 409 giftExhausted,
    // бронь остаётся в PENDING_PAYMENT (транзакция откатилась)
    const movies = await api<{ data: E2EMovie[] }>('/movies');
    const session = movies.data[0].sessions[0];
    const seat = await freeSeat(session.id);
    const raw = await api<BookingDto>('/bookings', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.id, seats: [seat] }),
    });
    const refused = await fetch(`${BASE}/bookings/${raw.id}/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ giftCode: activated.code }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe(
      'giftExhausted',
    );
  });

  it('отмена подтверждённой брони возвращает деньги на карту', async () => {
    if (!available) return;

    const gift = await api<GiftDto>('/gifts', {
      method: 'POST',
      body: JSON.stringify({ nominalRub: 5000 }),
    });
    await api<GiftDto>('/gifts/activate', {
      method: 'POST',
      body: JSON.stringify({ code: gift.code }),
    });

    const booking = await paidBooking(gift.code);
    const spent = booking.giftSpent ?? 0;
    expect(spent).toBeGreaterThan(0);
    const balanceBefore = (await api<GiftsMy>('/gifts/my')).totals.availableRub;

    // сага возврата: CONFIRMED → CANCELLING → CANCELLED, деньги — на карту
    await api<BookingDto>(`/bookings/${booking.id}/cancel`, { method: 'POST' });
    const verdict = await waitForStatus(booking.id, 'CANCELLING');
    expect(verdict.status).toBe('CANCELLED');

    const balanceAfter = (await api<GiftsMy>('/gifts/my')).totals.availableRub;
    expect(balanceAfter).toBe(balanceBefore + spent);
  });
});

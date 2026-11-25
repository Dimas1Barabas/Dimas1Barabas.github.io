/**
 * Демо-движок: уровни «Киноман» — зеркало loyalty.levels.ts и
 * LoyaltyService.my API: лестница трат, перки, прогресс floor, скидка
 * бара снимком, кэшбэк с прибавкой уровня на пороге.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { freeSeat, firstFreeSeats, seatPriceOf, firstSession } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: уровни «Киноман»', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 0.1 < SUCCESS_RATE/REFUND_SUCCESS_RATE — вердикты и возвраты успешны */
  function happyRandom() {
    return vi.spyOn(Math, 'random').mockReturnValue(0.1);
  }

  /** CONFIRMED-бронь на count мест: свежий уровень гостя подрастает */
  async function confirmBooking(seatsCount: number): Promise<{ id: string; totalRub: number }> {
    const spy = happyRandom();
    const { session } = firstSession();
    const price = seatPriceOf(session.id);
    const seats = firstFreeSeats(demoEngine.seatMap(session.id), seatsCount);
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats,
    });
    demoEngine.pay(booking.id);
    await vi.advanceTimersByTimeAsync(3000);
    spy.mockRestore();
    expect(demoEngine.list()[0].status).toBe('CONFIRMED');
    return { id: booking.id, totalRub: price * seatsCount };
  }

  it('свежая демо-сессия: Новичок без перков, впереди Зритель', () => {
    expect(demoEngine.myLoyalty()).toEqual({
      code: 'newcomer',
      name: 'Новичок',
      lifetimeSpentRub: 0,
      perks: {
        cashbackPercent: 5,
        barDiscountPercent: 0,
        demandMarkupWaived: false,
      },
      next: { name: 'Зритель', toNextRub: 3000, progressPercent: 0 },
    });
  });

  it('сид-«другие зрители» не растят траты гостя — как LOYALTY_SPENT_SQL', () => {
    // сидов с CONFIRMED много, но все с чужим userId
    expect(demoEngine.myLoyalty().lifetimeSpentRub).toBe(0);
  });

  it('заказ бара Новичка — без скидки, процент-снимок 0', () => {
    const order = demoEngine.createBarOrder({
      items: [{ itemId: 'demo-bar-combo-family', qty: 2 }], // 890 × 2
    });
    expect(order.loyaltyDiscountPercent).toBe(0);
    expect(order.totalRub).toBe(1780);
  });

  it('CONFIRMED-бронь перешагивает порог Зрителя — перки и прогресс floor', async () => {
    const { totalRub: spent } = await confirmBooking(8); // ≥ 3000 ₽ за одну бронь
    expect(spent).toBeGreaterThanOrEqual(3000);

    const status = demoEngine.myLoyalty();
    expect(status.code).toBe('viewer');
    expect(status.name).toBe('Зритель');
    expect(status.lifetimeSpentRub).toBe(spent);
    expect(status.perks).toEqual({
      cashbackPercent: 7, // базовый 5% + 2 п.п. Зрителя
      barDiscountPercent: 5,
      demandMarkupWaived: false,
    });
    expect(status.next).toEqual({
      name: 'Киноман',
      toNextRub: 10000 - spent,
      // floor, не round: доля пути до копейки не рисует «целые» проценты
      progressPercent: Math.floor(((spent - 3000) / 7000) * 100),
    });
  });

  it('покупка на пороге сразу зарабатывает новую ставку кэшбэка', async () => {
    const { totalRub: spent } = await confirmBooking(8); // 0 → Зритель этой оплатой
    const cashback = Math.floor(spent * 0.07); // 5% + 2 п.п. уровня
    const account = demoEngine.myBonuses();
    expect(account.transactions[0]).toMatchObject({
      kind: 'accrual',
      reason: 'cashback',
      amount: cashback,
    });
    expect(account.balance).toBe(350 + cashback); // сид счёта + новый кэшбэк
  });

  it('скидка уровня в заказе бара: 5% Зрителя, floor до рубля', async () => {
    await confirmBooking(8); // Зритель
    const order = demoEngine.createBarOrder({
      items: [{ itemId: 'demo-bar-combo-family', qty: 2 }], // 890 × 2 = 1780
    });
    expect(order.loyaltyDiscountPercent).toBe(5);
    expect(order.totalRub).toBe(1780 - Math.floor(1780 * 0.05)); // 1691
  });

  it('возврат брони понижает траты самим статусом — уровень назад к Новичку', async () => {
    const { id } = await confirmBooking(8);
    expect(demoEngine.myLoyalty().code).toBe('viewer');

    const spy = happyRandom();
    demoEngine.cancel(id);
    await vi.advanceTimersByTimeAsync(2000);
    spy.mockRestore();
    const refunded = demoEngine.list().find((b) => b.id === id);
    expect(refunded?.status).toBe('CANCELLED');

    const status = demoEngine.myLoyalty();
    expect(status.lifetimeSpentRub).toBe(0);
    expect(status.code).toBe('newcomer');
    expect(status.next).toEqual({
      name: 'Зритель',
      toNextRub: 3000,
      progressPercent: 0,
    });
  });

  it('неоплаченные и несостоявшиеся брони трат не растят', async () => {
    const { session } = firstSession();
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Тест',
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(demoEngine.myLoyalty().lifetimeSpentRub).toBe(0);
  });
});

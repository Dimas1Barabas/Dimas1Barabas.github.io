/**
 * Демо-движок: гифт-сертификаты — зеркало контракта API (этап 33):
 * покупка с границами номинала, одноразовая активация, частичное
 * списание в оплате после промокода и бонусов, возвраты при FAILED
 * и отмене. Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { freeSeat, firstSession } from '@/shared/api/demo-spec-helpers';

/** бронь на 1 место, ждущая оплаты */
function pendingBooking(): { id: string; totalRub: number } {
  const { session } = firstSession();
  const seat = freeSeat(demoEngine.seatMap(session.id));
  const booking = demoEngine.create({
    sessionId: session.id,
    customerName: 'Гость',
    seats: [seat],
  });
  return { id: booking.id, totalRub: booking.totalRub };
}

/** ошибка движка как объект с кодом причины */
function errCode(err: unknown): { status: number; code: string } {
  expect(err).toBeInstanceOf(ApiError);
  const apiErr = err as ApiError;
  return {
    status: apiErr.status,
    code: (JSON.parse(apiErr.body) as { code?: string }).code ?? '',
  };
}

describe('demoEngine: гифт-сертификаты', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('витрина: сид-карта активна, доступно 500 ₽', () => {
    const my = demoEngine.myGifts();

    expect(my.totals).toEqual({ availableRub: 500, cards: 1, given: 0 });
    expect(my.cards[0]).toMatchObject({
      code: 'GIFT-DEM0CA11',
      nominalRub: 1000,
      remainingRub: 500,
      status: 'active',
    });
  });

  it('покупка: границы и кратность номинала — те же 400, что в API', () => {
    expect(demoEngine.buyGift(1500).nominalRub).toBe(1500);
    for (const bad of [499, 50_100, 1999]) {
      try {
        demoEngine.buyGift(bad);
        throw new Error(`должен был упасть 400 на ${bad}`);
      } catch (err) {
        expect(errCode(err).status).toBe(400);
      }
    }
  });

  it('активация: одноразовая, регистр не важен; повтор и опечатка — как API', () => {
    const bought = demoEngine.buyGift(2000);
    expect(bought.status).toBe('purchased');

    const activated = demoEngine.activateGift(` ${bought.code.toLowerCase()} `);
    expect(activated).toMatchObject({ status: 'active', remainingRub: 2000 });

    try {
      demoEngine.activateGift(bought.code);
      throw new Error('должен был упасть 409');
    } catch (err) {
      expect(errCode(err)).toMatchObject({
        status: 409,
        code: 'giftAlreadyActivated',
      });
    }
    try {
      demoEngine.activateGift('GIFT-NOPE1234');
      throw new Error('должен был упасть 404');
    } catch (err) {
      expect(errCode(err)).toMatchObject({ status: 404, code: 'giftNotFound' });
    }
  });

  it('списание в оплате: карта закрывает хвост частично, остаток живёт', () => {
    const { id, totalRub } = pendingBooking();

    const paid = demoEngine.pay(id, undefined, undefined, 'gift-dem0ca11');

    const spent = Math.min(500, totalRub);
    expect(paid.giftCode).toBe('GIFT-DEM0CA11');
    expect(paid.giftSpent).toBe(spent);
    expect(paid.totalRub).toBe(totalRub - spent);
    expect(demoEngine.myGifts().totals.availableRub).toBe(500 - spent);
  });

  it('неактивированный код — 409 giftNotYours с подсказкой активировать', () => {
    const bought = demoEngine.buyGift(5000);
    const { id } = pendingBooking();

    try {
      demoEngine.pay(id, undefined, undefined, bought.code);
      throw new Error('должен был упасть 409');
    } catch (err) {
      expect(errCode(err)).toMatchObject({ status: 409, code: 'giftNotYours' });
    }
    // бронь не тронута — оплата откатилась целиком
    expect(demoEngine.myGifts().totals.availableRub).toBe(500);
  });

  it('до нуля: exhausted, следующая оплата — 409 giftExhausted', () => {
    // добиваем сид-карту (остаток 500) чеками по одному месту
    let guard = 0;
    while (demoEngine.myGifts().totals.availableRub > 0 && guard++ < 5) {
      const { id } = pendingBooking();
      demoEngine.pay(id, undefined, undefined, 'GIFT-DEM0CA11');
      vi.advanceTimersByTimeAsync(3000);
    }
    expect(demoEngine.myGifts().totals.availableRub).toBe(0);
    expect(demoEngine.myGifts().cards[0].status).toBe('exhausted');

    const { id } = pendingBooking();
    try {
      demoEngine.pay(id, undefined, undefined, 'GIFT-DEM0CA11');
      throw new Error('должен был упасть 409');
    } catch (err) {
      expect(errCode(err)).toMatchObject({ status: 409, code: 'giftExhausted' });
    }
  });

  it('промокод закрыл чек целиком — 409 giftNothingToPay', () => {
    const { id, totalRub } = pendingBooking();
    // фикс-промо ровно на чек: после него гифту закрывать нечего
    demoEngine.createPromo({
      code: 'FULLCOVER',
      kind: 'fixed',
      value: totalRub,
      maxActivations: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    try {
      demoEngine.pay(id, 'FULLCOVER', undefined, 'GIFT-DEM0CA11');
      throw new Error('должен был упасть 409');
    } catch (err) {
      expect(errCode(err)).toMatchObject({
        status: 409,
        code: 'giftNothingToPay',
      });
    }
    // карта не тронута — транзакция откатилась целиком
    expect(demoEngine.myGifts().totals.availableRub).toBe(500);
  });

  it('отмена оплаченной брони возвращает деньги на карту', async () => {
    // вердикты и возврат всегда успешны (как в тестовой сборке демо)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const { id } = pendingBooking();
    const paid = demoEngine.pay(id, undefined, undefined, 'GIFT-DEM0CA11');
    const spent = paid.giftSpent ?? 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(paid.status).toBe('CONFIRMED');
    const before = demoEngine.myGifts().totals.availableRub;

    demoEngine.cancel(paid.id);
    await vi.advanceTimersByTimeAsync(3000); // сага возврата прошла

    randomSpy.mockRestore();
    expect(paid.status).toBe('CANCELLED');
    expect(demoEngine.myGifts().totals.availableRub).toBe(before + spent);
  });
});

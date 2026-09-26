/**
 * Демо-движок: бонусы: ledger в миниатюре — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { freeSeat, firstFreeSeats, seatPriceOf, firstSession } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: бонусы: ledger в миниатюре', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('бонусы: ledger в миниатюре', () => {
    /** 0.1 < SUCCESS_RATE/REFUND_SUCCESS_RATE — вердикты и возвраты успешны */
    function happyRandom() {
      return vi.spyOn(Math, 'random').mockReturnValue(0.1);
    }

    it('сид счёта: баланс 350, история тремя движениями свежими сверху', () => {
      const account = demoEngine.myBonuses();

      expect(account.balance).toBe(350);
      expect(account.transactions).toHaveLength(3);
      expect(account.transactions[0].reason).toBe('cashback'); // 2 дня назад
      expect(account.transactions[2].reason).toBe('cashback'); // 10 дней назад
    });

    it('pay с бонусами: списание до вердикта, кэшбэк 5% от финальной суммы', async () => {
      const spy = happyRandom();
      const { session } = firstSession();
      const price = seatPriceOf(session.id);
      expect(price).toBeGreaterThanOrEqual(200);
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });
      const spend = 100; // ≤ половины чека и ≤ баланса 350

      const paid = demoEngine.pay(booking.id, undefined, spend);
      expect(paid.totalRub).toBe(price - spend);
      expect(paid.bonusSpent).toBe(spend);
      expect(demoEngine.myBonuses().balance).toBe(250);

      await vi.advanceTimersByTimeAsync(3000);
      spy.mockRestore();
      const done = demoEngine.list()[0];
      expect(done.status).toBe('CONFIRMED');
      // кэшбэк 5% от финальной суммы, floor
      const cashback = Math.floor((price - spend) * 0.05);
      expect(demoEngine.myBonuses().balance).toBe(250 + cashback);
      expect(demoEngine.myBonuses().transactions[0]).toMatchObject({
        kind: 'accrual',
        reason: 'cashback',
        amount: cashback,
        bookingId: booking.id,
      });
    });

    it('больше половины чека — 409 bonusOverLimit, бронь осталась payable', () => {
      const { session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });
      const tooMuch = Math.floor(booking.totalRub / 2) + 1;

      try {
        demoEngine.pay(booking.id, undefined, tooMuch);
        expect.unreachable('должен был бросить 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('bonusOverLimit');
      }
      expect(demoEngine.list()[0].status).toBe('PENDING_PAYMENT');
      expect(demoEngine.myBonuses().balance).toBe(350);
    });

    it('не хватает баланса — 409 bonusInsufficient', () => {
      const { session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: firstFreeSeats(demoEngine.seatMap(session.id), 2),
      });
      const total = booking.totalRub;
      const spend = Math.min(Math.floor(total / 2), 400); // лимит ок

      try {
        demoEngine.pay(booking.id, undefined, spend);
        expect.unreachable('должен был бросить 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe(
          'bonusInsufficient',
        );
      }
    });

    it('FAILED-вердикт возвращает списанное', async () => {
      // 0.95 > SUCCESS_RATE — воркер отклоняет платёж
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.95);
      const { session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });

      demoEngine.pay(booking.id, undefined, 100);
      expect(demoEngine.myBonuses().balance).toBe(250);

      await vi.advanceTimersByTimeAsync(3000);
      spy.mockRestore();
      expect(demoEngine.list()[0].status).toBe('FAILED');
      expect(demoEngine.myBonuses().balance).toBe(350);
      expect(demoEngine.myBonuses().transactions[0]).toMatchObject({
        kind: 'accrual',
        reason: 'payment_failed',
        amount: 100,
      });
    });

    it('отмена CONFIRMED-брони: разворот — списанное вернулось, кэшбэк погасился', async () => {
      const spy = happyRandom();
      const { session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Тест',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });

      demoEngine.pay(booking.id, undefined, 100);
      await vi.advanceTimersByTimeAsync(3000); // CONFIRMED + кэшбэк 12 (250×5%)
      demoEngine.cancel(booking.id);
      await vi.advanceTimersByTimeAsync(2000); // возврат прошёл
      spy.mockRestore();

      const account = demoEngine.myBonuses();
      const cashback = Math.floor((booking.totalRub - 100) * 0.05);
      // 350 − 100 + кэшбэк + 100 (refund) − кэшбэк (clawback) = 350
      expect(account.balance).toBe(350);
      const reasons = account.transactions
        .filter((t) => t.bookingId === booking.id)
        .map((t) => `${t.kind}/${t.reason}`);
      expect(reasons).toContain('spend/payment');
      expect(reasons).toContain(`accrual/cashback`);
      expect(reasons).toContain('accrual/refund');
      expect(reasons).toContain('spend/clawback');
    });
  });

});

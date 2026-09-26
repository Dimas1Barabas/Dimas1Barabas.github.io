/**
 * Демо-движок: промокоды — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { firstFreeSeats, seatPriceOf, firstSession } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: промокоды', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('промокоды', () => {
    /** неоплаченная бронь на 2 места первого фильма */
    function unpaidBooking() {
      const { session } = firstSession();
      const seats = firstFreeSeats(demoEngine.seatMap(session.id), 2);
      return {
        total: seatPriceOf(session.id) * 2,
        booking: demoEngine.create({
          sessionId: session.id,
          customerName: 'Промо',
          seats,
        }),
      };
    }

    it('validatePromo: превью процента и фикс-скидки, без списания', () => {
      const { total, booking } = unpaidBooking();

      const percent = demoEngine.validatePromo({
        code: 'cine10',
        bookingId: booking.id,
      });
      expect(percent).toEqual({
        code: 'CINE10',
        kind: 'percent',
        value: 10,
        discountRub: Math.round(total * 0.1),
        totalRub: total - Math.round(total * 0.1),
      });

      const fixed = demoEngine.validatePromo({
        code: 'SUMMER300',
        bookingId: booking.id,
      });
      expect(fixed.discountRub).toBe(300);
      expect(fixed.totalRub).toBe(total - 300);

      // превью ничего не списало
      const summer = demoEngine.listPromos().find((p) => p.code === 'SUMMER300');
      expect(summer?.usedCount).toBe(2);
    });

    it('validatePromo: 404 promoNotFound, 410 promoExpired, 409 promoExhausted', () => {
      const { booking } = unpaidBooking();
      const call = (code: string) =>
        demoEngine.validatePromo({ code, bookingId: booking.id });

      try {
        call('NOPE');
        throw new Error('ожидали 404');
      } catch (err) {
        expect((err as ApiError).status).toBe(404);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoNotFound');
      }

      try {
        call('EXPIRED5');
        throw new Error('ожидали 410');
      } catch (err) {
        expect((err as ApiError).status).toBe(410);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExpired');
      }

      // SUMMER300: 2 из 3 — последнюю забираем, дальше исчерпан
      demoEngine.pay(booking.id, 'SUMMER300');
      const { booking: next } = unpaidBooking();
      try {
        demoEngine.validatePromo({ code: 'SUMMER300', bookingId: next.id });
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExhausted');
      }
    });

    it('pay с промокодом: скидка на брони, счётчик растёт, вердикт со скидочной суммой', async () => {
      const { total, booking } = unpaidBooking();

      const paid = demoEngine.pay(booking.id, 'CINE10');
      expect(paid.status).toBe('PENDING');
      expect(paid.promoCode).toBe('CINE10');
      expect(paid.discountRub).toBe(Math.round(total * 0.1));
      expect(paid.totalRub).toBe(total - Math.round(total * 0.1));

      const cine = demoEngine.listPromos().find((p) => p.code === 'CINE10');
      expect(cine?.usedCount).toBe(1);

      // «воркер» подтверждает со скидочной суммой
      vi.spyOn(Math, 'random').mockReturnValue(0.1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(paid.status).toBe('CONFIRMED');
      expect(paid.message).toContain(String(paid.totalRub));
      vi.restoreAllMocks();
    });

    it('pay: код исчерпан — 409, бронь осталась payable', () => {
      const { booking: warm } = unpaidBooking();
      demoEngine.pay(warm.id, 'SUMMER300'); // 3 из 3 — лимит кончился

      const { booking } = unpaidBooking();
      try {
        demoEngine.pay(booking.id, 'SUMMER300');
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExhausted');
      }
      // «транзакция откатилась»: статус не переключён, место всё ещё её
      expect(booking.status).toBe('PENDING_PAYMENT');
      const stillPayable = demoEngine.pay(booking.id);
      expect(stillPayable.promoCode).toBeNull();
      expect(stillPayable.totalRub).toBe(booking.totalRub);
    });

    it('createPromo: дубль — 409 promoExists, процент >99 — 400; reset восстанавливает сиды', () => {
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      demoEngine.createPromo({
        code: 'newcode',
        kind: 'fixed',
        value: 150,
        maxActivations: 5,
        expiresAt,
      });
      expect(demoEngine.listPromos().some((p) => p.code === 'NEWCODE')).toBe(true);

      try {
        demoEngine.createPromo({
          code: 'NewCode',
          kind: 'fixed',
          value: 150,
          maxActivations: 5,
          expiresAt,
        });
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('promoExists');
      }

      try {
        demoEngine.createPromo({
          code: 'TOOBIG',
          kind: 'percent',
          value: 150,
          maxActivations: 5,
          expiresAt,
        });
        throw new Error('ожидали 400');
      } catch (err) {
        expect((err as ApiError).status).toBe(400);
      }

      demoEngine.reset();
      const codes = demoEngine.listPromos().map((p) => p.code);
      expect(codes).toEqual(
        expect.arrayContaining(['CINE10', 'SUMMER300', 'EXPIRED5']),
      );
      expect(codes).not.toContain('NEWCODE');
    });
  });

});

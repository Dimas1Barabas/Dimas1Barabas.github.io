/**
 * Демо-движок: антифрод «Детектив» (этап 36) — скоринг чекаута, холд
 * оплаты и решения человека в витрине. Зеркало контракта API
 * (409 fraudBlocked/fraudReview, resolve approve/reject) и правил
 * Go-домена (векторы — в shared/lib/fraud.spec).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { freeSeat, firstFreeSeats, firstSession } from './demo-spec-helpers';

/** тело ApiError движка — JSON-строка, как ответ API; бросок обязателен */
function expectApiError(fn: () => unknown, code: string): Record<string, unknown> {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiError);
  const body = JSON.parse((caught as ApiError).body) as Record<string, unknown>;
  expect(body).toMatchObject({ code });
  return body;
}

/** брони гостя (userId null): сид-«другие зрители» не в счёте */
function guestBookings() {
  return demoEngine.list().filter((b) => b.userId === null);
}

/**
 * Разгон velocity: count односельных броней гостя. Срез фактов берётся
 * ДО создания брони чекаута (как Score до create в API), поэтому для
 * правила «5+ броней» нужно пять предыдущих.
 */
function rampUp(sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    demoEngine.create({
      sessionId,
      seats: [freeSeat(demoEngine.seatMap(sessionId))],
    });
  }
}

describe('demoEngine: антифрод «Детектив»', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('свежий счёт, спокойная покупка — allow: бронь сразу в PENDING', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { session } = firstSession();

    const booking = demoEngine.checkout({
      sessionId: session.id,
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });

    expect(booking.status).toBe('PENDING');
    expect(booking.fraudHold).toBe(false);
    const decisions = demoEngine.fraudDecisionsList();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      verdict: 'allow',
      score: 30, // newAccount: демо-счёт моложе суток
      status: 'auto_allowed',
      reasons: ['newAccount'],
    });
    randomSpy.mockRestore();
  });

  it('пять броней за сутки — review: холд, оплата не запускается', () => {
    const { session } = firstSession();
    rampUp(session.id, 5); // срез видит 5 до создания брони → newAccount(30)+velocity(25)=55

    const booking = demoEngine.checkout({
      sessionId: session.id,
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });

    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.fraudHold).toBe(true);
    expect(booking.message).toContain('антифрода');
    const pending = demoEngine.fraudDecisionsList('pending_review');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      bookingId: booking.id,
      score: 55,
      reasons: ['newAccount', 'velocity'],
    });
  });

  it('холд держит оплату: pay — 409 fraudReview', () => {
    const { session } = firstSession();
    rampUp(session.id, 5);
    const booking = demoEngine.checkout({
      sessionId: session.id,
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });

    expectApiError(() => demoEngine.pay(booking.id), 'fraudReview');
  });

  it('approve: системная оплата запускается, решение — approved', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const { session } = firstSession();
    rampUp(session.id, 5);
    const booking = demoEngine.checkout({
      sessionId: session.id,
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });

    const res = demoEngine.resolveFraud(booking.id, 'approve', 'admin@demo.local');

    expect(res.resolved).toBe('approved');
    expect(res.booking.status).toBe('PENDING'); // оплата запущена
    const decision = demoEngine
      .fraudDecisionsList()
      .find((d) => d.bookingId === booking.id);
    expect(decision).toMatchObject({
      status: 'approved',
      resolvedBy: 'admin@demo.local',
    });
    // повторное решение — честный 409
    expectApiError(
      () => demoEngine.resolveFraud(booking.id, 'reject', 'admin@demo.local'),
      'fraudAlreadyResolved',
    );
  });

  it('reject: неоплаченная бронь гасится, места в продаже, решение — rejected', () => {
    const { session } = firstSession();
    rampUp(session.id, 5);
    const seat = freeSeat(demoEngine.seatMap(session.id));
    const booking = demoEngine.checkout({ sessionId: session.id, seats: [seat] });

    const res = demoEngine.resolveFraud(booking.id, 'reject', 'admin@demo.local');

    expect(res.resolved).toBe('rejected');
    expect(res.booking.status).toBe('CANCELLED');
    // место вернулось в продажу
    expect(demoEngine.seatMap(session.id).occupied).not.toContain(seat);
    expect(demoEngine.fraudDecisionsList('rejected')).toHaveLength(1);
  });

  it('конвейер 10+ броней с полрядом мест — block: брони нет, 409 fraudBlocked', () => {
    const { session } = firstSession();
    rampUp(session.id, 10);
    const countBefore = guestBookings().length;

    const body = expectApiError(
      () =>
        demoEngine.checkout({
          sessionId: session.id,
          seats: firstFreeSeats(demoEngine.seatMap(session.id), 6),
        }),
      'fraudBlocked',
    );

    expect(body).toMatchObject({
      score: 75,
      reasons: ['newAccount', 'velocityHigh', 'manySeats'],
    });
    // бронь не создана вовсе; решение в витрине под синтетическим id
    expect(guestBookings()).toHaveLength(countBefore);
    const blocked = demoEngine.fraudDecisionsList('auto_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].bookingId).toMatch(/^demo-fraud-\d+$/);
  });

  it('резолв чужого id — 404 fraudDecisionNotFound', () => {
    expectApiError(
      () => demoEngine.resolveFraud('нет-такого', 'approve', 'a@b.c'),
      'fraudDecisionNotFound',
    );
  });

  it('истёкший холд: бронь ушла из PENDING_PAYMENT — 409 fraudResolveConflict', () => {
    const { session } = firstSession();
    rampUp(session.id, 5);
    const booking = demoEngine.checkout({
      sessionId: session.id,
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });
    // таймаут резерва сработал раньше решения
    vi.advanceTimersByTime(121_000);
    expect(
      demoEngine.list().find((b) => b.id === booking.id)?.status,
    ).toBe('EXPIRED');

    expectApiError(
      () => demoEngine.resolveFraud(booking.id, 'approve', 'a@b.c'),
      'fraudResolveConflict',
    );
    // но решение зафиксировано честно
    expect(
      demoEngine.fraudDecisionsList().find((d) => d.bookingId === booking.id)
        ?.status,
    ).toBe('approved');
  });
});

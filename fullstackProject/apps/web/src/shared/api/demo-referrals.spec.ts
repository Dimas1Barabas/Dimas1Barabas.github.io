/**
 * Демо-движок: реферальная программа: код приглашения и welcome-бонус —
 * зеркало контракта API (этап 31). Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { freeSeat, firstSession } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: реферальная программа', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('витрина «Пригласить»: системный код, размеры бонусов и демо-друзья', () => {
    const my = demoEngine.myReferrals();

    expect(my.code).toBe('DEM0C0DE');
    expect(my.bonusInviter).toBe(300);
    expect(my.bonusFriend).toBe(100);
    expect(my.totals).toEqual({ invited: 2, paid: 1, earned: 300 });
    expect(my.invited).toHaveLength(2);
    expect(my.invited[0]).toMatchObject({ name: 'Мария', paid: true });
    expect(my.invited[1]).toMatchObject({ name: 'Пётр', paid: false });
  });

  it('регистрация принимает код в любом регистре и с обводками', () => {
    const user = demoEngine.register({
      email: 'friend@example.com',
      password: 'secret123',
      name: 'Друг',
      referralCode: ' dem0c0de ',
    });

    expect(user).toMatchObject({ email: 'friend@example.com', role: 'user' });
  });

  it('опечатка в коде — 400 referralCodeUnknown, как UsersService.register', () => {
    try {
      demoEngine.register({
        email: 'friend@example.com',
        password: 'secret123',
        name: 'Друг',
        referralCode: 'NOPE1234',
      });
      throw new Error('должен был упасть 400');
    } catch (err) {
      expect((err as ApiError).status).toBe(400);
      expect(JSON.parse((err as ApiError).body).code).toBe(
        'referralCodeUnknown',
      );
    }
  });

  it('welcome-бонус падает за первую оплаченную бронь — и только за первую', async () => {
    // 0.1 < SUCCESS_RATE — вердикты успешны
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    demoEngine.register({
      email: 'friend@example.com',
      password: 'secret123',
      name: 'Друг',
      referralCode: 'DEM0C0DE',
    });

    const makeBooking = () => {
      const { session } = firstSession();
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Друг',
        seats: [freeSeat(demoEngine.seatMap(session.id))],
      });
      demoEngine.pay(booking.id);
      return booking;
    };

    makeBooking();
    await vi.advanceTimersByTimeAsync(3000);
    makeBooking();
    await vi.advanceTimersByTimeAsync(3000);
    spy.mockRestore();

    const welcome = demoEngine
      .myBonuses()
      .transactions.filter((t) => t.reason === 'referral_welcome');
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ kind: 'accrual', amount: 100 });
  });

  it('без кода welcome не начисляется', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    demoEngine.register({
      email: 'solo@example.com',
      password: 'secret123',
      name: 'Сам по себе',
    });

    const { session } = firstSession();
    const booking = demoEngine.create({
      sessionId: session.id,
      customerName: 'Сам по себе',
      seats: [freeSeat(demoEngine.seatMap(session.id))],
    });
    demoEngine.pay(booking.id);
    await vi.advanceTimersByTimeAsync(3000);
    spy.mockRestore();

    expect(
      demoEngine.myBonuses().transactions.filter(
        (t) => t.reason === 'referral_welcome',
      ),
    ).toHaveLength(0);
  });
});

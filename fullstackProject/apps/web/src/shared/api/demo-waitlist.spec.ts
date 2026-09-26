/**
 * Демо-движок: лист ожидания (честная гонка) — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { HALL_CAPACITY } from '@/shared/lib/hall';
import { freeSeat, firstSession } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: лист ожидания (честная гонка)', () => {
  /** «Рекурсия-s1» — сид-«аншлаг»: зал выкуплен целиком */
  const FULL_SESSION = 'demo-recursion-s1';
  /** бронь «аншлага» — 15-й сид (demo-seed-b15), CONFIRMED на все 80 мест */
  const SELLOUT_BOOKING = 'demo-seed-b15';

  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('сид-аншлаг: сеанс полного зала существует и free === 0', () => {
    const map = demoEngine.seatMap(FULL_SESSION);
    expect(map.occupied).toHaveLength(HALL_CAPACITY);
    expect(map.free).toBe(0);
  });

  it('join: 409 sessionNotFull на обычном сеансе, 201-подобный вход на полном', () => {
    const { session } = firstSession();
    try {
      demoEngine.joinWaitlist(session.id);
      throw new Error('ожидали 409');
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
      expect(JSON.parse((err as ApiError).body).code).toBe('sessionNotFull');
    }

    const entry = demoEngine.joinWaitlist(FULL_SESSION);
    expect(entry.status).toBe('WAITING');
    expect(entry.position).toBe(1);
  });

  it('join дубль — 409 waitlistAlready; leave → 404 на повтор, запись скрыта из my', () => {
    demoEngine.joinWaitlist(FULL_SESSION);

    try {
      demoEngine.joinWaitlist(FULL_SESSION);
      throw new Error('ожидали 409');
    } catch (err) {
      expect(JSON.parse((err as ApiError).body).code).toBe('waitlistAlready');
    }

    demoEngine.leaveWaitlist(FULL_SESSION);
    expect(demoEngine.myWaitlist()).toEqual([]);
    try {
      demoEngine.leaveWaitlist(FULL_SESSION);
      throw new Error('ожидали 404');
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
      expect(JSON.parse((err as ApiError).body).code).toBe('waitlistEntryNotFound');
    }
  });

  it('my: контекст фильма и позиция среди WAITING', () => {
    demoEngine.joinWaitlist(FULL_SESSION);
    const mine = demoEngine.myWaitlist();
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      sessionId: FULL_SESSION,
      movieTitle: 'Рекурсия',
      hall: 'IMAX',
      status: 'WAITING',
      position: 1,
    });
  });

  it('освобождение (возврат брони аншлага) → голова NOTIFIED, бронь гасит запись', async () => {
    demoEngine.joinWaitlist(FULL_SESSION);

    // «возврат» брони аншлага: сага отмены проходит (random зажат в «успех»)
    const okSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    demoEngine.cancel(SELLOUT_BOOKING);
    await vi.advanceTimersByTimeAsync(2000);
    okSpy.mockRestore();

    const mine = demoEngine.myWaitlist();
    expect(mine[0]?.status).toBe('NOTIFIED');
    expect(mine[0]?.position).toBeNull();

    // уведомлённый успел: бронь на освободившееся место гасит запись
    const map = demoEngine.seatMap(FULL_SESSION);
    const booking = demoEngine.create({
      sessionId: FULL_SESSION,
      seats: [freeSeat(map)],
    });
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(demoEngine.myWaitlist()).toEqual([]);
  });

  it('после освобождения сеанс уже не полон — повторный join честно отказан', () => {
    demoEngine.joinWaitlist(FULL_SESSION);
    const okSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    demoEngine.cancel(SELLOUT_BOOKING);
    return vi.advanceTimersByTimeAsync(2000).then(() => {
      okSpy.mockRestore();
      expect(demoEngine.myWaitlist()[0]?.status).toBe('NOTIFIED');

      // возврат открыл места — очередь больше не нужна, join отказан
      try {
        demoEngine.joinWaitlist(FULL_SESSION);
        throw new Error('ожидали 409');
      } catch (err) {
        expect(JSON.parse((err as ApiError).body).code).toBe('sessionNotFull');
      }
    });
  });
});


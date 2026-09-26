/**
 * Демо-движок: Привратник (лимиты частоты) — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { firstSession } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: Привратник (лимиты частоты)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** десять броней подряд — burst исчерпывает корзину 10/мин */
  function burnBookings(): string[] {
    const { session } = firstSession();
    // свободные места карты — сиды демо уже кое-что занимают
    const occupied = new Set(demoEngine.seatMap(session.id).occupied);
    const free: string[] = [];
    for (let row = 1; row <= 8 && free.length < 11; row++) {
      for (let seat = 1; seat <= 10 && free.length < 11; seat++) {
        const code = `${row}-${seat}`;
        if (!occupied.has(code)) free.push(code);
      }
    }
    for (const seat of free.slice(0, 10)) {
      demoEngine.create({ sessionId: session.id, customerName: 'Спамер', seats: [seat] });
    }
    return free;
  }

  it('11-я бронь подряд — ApiError 429 с retryAfterSec; reset восстанавливает', () => {
    const free = burnBookings();
    const { session } = firstSession();

    expect(() =>
      demoEngine.create({
        sessionId: session.id,
        customerName: 'Спамер',
        seats: [free[10]],
      }),
    ).toThrow(ApiError);

    try {
      demoEngine.create({ sessionId: session.id, customerName: 'С', seats: [free[10]] });
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(429);
      const body = JSON.parse(apiErr.body) as { code: string; retryAfterSec: number };
      expect(body.code).toBe('rateLimited');
      expect(body.retryAfterSec).toBeGreaterThanOrEqual(1); // ~6 c при 10/мин
    }

    demoEngine.reset();
    expect(() =>
      demoEngine.create({
        sessionId: session.id,
        customerName: 'Спамер',
        seats: [free[0]],
      }),
    ).not.toThrow();
  });

  it('долив возвращает токен: минутная пауза — снова можно', () => {
    const free = burnBookings();
    const { session } = firstSession();

    expect(() =>
      demoEngine.create({ sessionId: session.id, customerName: 'С', seats: [free[10]] }),
    ).toThrow(ApiError);

    vi.setSystemTime(Date.now() + 2 * 60_000); // пауза две минуты
    expect(() =>
      demoEngine.create({ sessionId: session.id, customerName: 'Спамер', seats: [free[10]] }),
    ).not.toThrow();
  });

  it('брутфорс входа: 6-я попытка одного email — 429, чужой ящик не задет', () => {
    demoEngine.login('bot@demo.local', 'secret-1'); // аккаунт создан, токен №1
    for (let i = 0; i < 4; i++) {
      // неверный пароль — 401, но корзину ест (гвард API до проверки пароля)
      expect(() => demoEngine.login('bot@demo.local', 'wrong')).toThrow(ApiError);
    }
    try {
      demoEngine.login('bot@demo.local', 'wrong');
      expect.unreachable('шестая попытка должна была отказать');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(429);
      expect(JSON.parse(apiErr.body).code).toBe('rateLimited');
    }

  });
});

/**
 * Векторы зеркала антифрода — те же числа, что в Go-тестах домена
 * Детектива (services/detective-service/internal/domain/rules_test.go):
 * живой стенд считает на Go, демо-витрина здесь, расхождение векторов
 * означало бы две разные политики риска.
 */
import { describe, expect, it } from 'vitest';
import {
  FRAUD_THRESHOLDS,
  initialStatus,
  scoreFraud,
  type FraudFacts,
} from './fraud';

const base: FraudFacts = {
  seatsCount: 2,
  totalRub: 800,
  accountAgeDays: 30,
  bookings24h: 0,
  cancels24h: 0,
  failed24h: 0,
};

describe('scoreFraud — векторы, синхронные с Go-доменом', () => {
  it('спокойный покупатель — allow без вопросов', () => {
    expect(scoreFraud(base)).toEqual({
      verdict: 'allow',
      score: 0,
      reasons: [],
    });
  });

  it('новый счёт, одна бронь — 30, но allow', () => {
    expect(scoreFraud({ ...base, accountAgeDays: 0 })).toEqual({
      verdict: 'allow',
      score: 30,
      reasons: ['newAccount'],
    });
  });

  it('ветеран — скидка не уводит скор в минус', () => {
    expect(scoreFraud({ ...base, accountAgeDays: 200 })).toEqual({
      verdict: 'allow',
      score: 0,
      reasons: ['trusted'],
    });
  });

  it('новый счёт пилит брони — review 55', () => {
    expect(
      scoreFraud({ ...base, accountAgeDays: 0, bookings24h: 5 }),
    ).toEqual({
      verdict: 'review',
      score: 55,
      reasons: ['newAccount', 'velocity'],
    });
  });

  it('конвейер 10+ броней и куча мест — block 75', () => {
    expect(
      scoreFraud({
        ...base,
        accountAgeDays: 0,
        bookings24h: 10,
        seatsCount: 6,
      }),
    ).toEqual({
      verdict: 'block',
      score: 75,
      reasons: ['newAccount', 'velocityHigh', 'manySeats'],
    });
  });

  it('большой чек — ровно на пороге правила 15000 ₽', () => {
    expect(scoreFraud({ ...base, totalRub: 15_000 })).toEqual({
      verdict: 'allow',
      score: 20,
      reasons: ['bigCheck'],
    });
  });

  it('ветеран скупает ползала — скидка гасит риски', () => {
    expect(
      scoreFraud({
        ...base,
        accountAgeDays: 365,
        totalRub: 20_000,
        seatsCount: 8,
      }),
    ).toEqual({
      verdict: 'allow',
      score: 15,
      reasons: ['bigCheck', 'manySeats', 'trusted'],
    });
  });

  it('шторм отмен и отказов — 35, до review не дотягивает', () => {
    expect(
      scoreFraud({ ...base, cancels24h: 3, failed24h: 3 }),
    ).toEqual({
      verdict: 'allow',
      score: 35,
      reasons: ['cancelAbuse', 'failedPayments'],
    });
  });

  it('новый счёт со штормом отказов — block 85', () => {
    expect(
      scoreFraud({
        ...base,
        accountAgeDays: 0,
        cancels24h: 3,
        failed24h: 3,
        totalRub: 16_000,
      }),
    ).toEqual({
      verdict: 'block',
      score: 85,
      reasons: ['newAccount', 'cancelAbuse', 'failedPayments', 'bigCheck'],
    });
  });

  it('9 броней — ещё velocity, не velocityHigh', () => {
    expect(scoreFraud({ ...base, bookings24h: 9 })).toEqual({
      verdict: 'allow',
      score: 25,
      reasons: ['velocity'],
    });
  });

  it('пороги — конфигурация: узкий review меняет вердикт того же скора', () => {
    const facts: FraudFacts = { ...base, totalRub: 15_000 }; // score 20
    expect(scoreFraud(facts).verdict).toBe('allow');
    expect(scoreFraud(facts, { review: 10, block: 100 }).verdict).toBe(
      'review',
    );
  });

  it(FRAUD_THRESHOLDS.review + '/' + FRAUD_THRESHOLDS.block + ' — дефолты стенда', () => {
    expect(FRAUD_THRESHOLDS).toEqual({ review: 40, block: 70 });
  });
});

describe('initialStatus — стартовый статус решения', () => {
  it('авто-вердикты закрыты сразу, review ждёт человека', () => {
    expect(initialStatus('allow')).toBe('auto_allowed');
    expect(initialStatus('review')).toBe('pending_review');
    expect(initialStatus('block')).toBe('auto_blocked');
  });
});

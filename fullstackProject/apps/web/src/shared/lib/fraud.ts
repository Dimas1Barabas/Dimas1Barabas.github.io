/**
 * Зеркало скоринга антифрода «Детектива» (этап 36) для демо-режима:
 * та же таблица правил и порогов, что в Go-домене детектива
 * (services/detective-service/internal/domain/rules.go). Векторы
 * фиксируются тестами с обеих сторон и обязаны совпадать — живой
 * стенд считает на Go, демо-витрина Pages здесь.
 */

/** срез фактов: чем дышит покупатель на момент решения */
export interface FraudFacts {
  seatsCount: number;
  totalRub: number;
  accountAgeDays: number;
  bookings24h: number;
  cancels24h: number;
  failed24h: number;
}

export type FraudVerdict = 'allow' | 'review' | 'block';

export interface FraudScore {
  verdict: FraudVerdict;
  score: number;
  reasons: string[];
}

/** пороги вердиктов — дефолты стенда (FRAUD_REVIEW_SCORE/BLOCK_SCORE) */
export const FRAUD_THRESHOLDS = { review: 40, block: 70 } as const;

/** правило риска: код (ездит в ответах), вес, предикат */
interface FraudRule {
  code: string;
  weight: number;
  fires: (f: FraudFacts) => boolean;
}

const RULES: FraudRule[] = [
  { code: 'newAccount', weight: 30, fires: (f) => f.accountAgeDays < 1 },
  {
    code: 'velocity',
    weight: 25,
    fires: (f) => f.bookings24h >= 5 && f.bookings24h < 10,
  },
  { code: 'velocityHigh', weight: 35, fires: (f) => f.bookings24h >= 10 },
  { code: 'cancelAbuse', weight: 20, fires: (f) => f.cancels24h >= 3 },
  { code: 'failedPayments', weight: 15, fires: (f) => f.failed24h >= 3 },
  { code: 'bigCheck', weight: 20, fires: (f) => f.totalRub >= 15_000 },
  { code: 'manySeats', weight: 10, fires: (f) => f.seatsCount >= 6 },
  // безупречная история — скидка риска: скор не уходит в минус
  { code: 'trusted', weight: -15, fires: (f) => f.accountAgeDays >= 180 },
];

/**
 * Скоринг: сумма весов сработавших правил (не ниже нуля) и вердикт
 * по порогам. Чистая функция — векторы совпадают с Go-тестами домена.
 */
export function scoreFraud(
  facts: FraudFacts,
  thresholds: { review: number; block: number } = FRAUD_THRESHOLDS,
): FraudScore {
  let score = 0;
  const reasons: string[] = [];
  for (const rule of RULES) {
    if (rule.fires(facts)) {
      score += rule.weight;
      reasons.push(rule.code);
    }
  }
  if (score < 0) score = 0;
  const verdict: FraudVerdict =
    score >= thresholds.block
      ? 'block'
      : score >= thresholds.review
        ? 'review'
        : 'allow';
  return { verdict, score, reasons };
}

/** решение витрины: факты, вердикт и жизненный цикл (демо-зеркало) */
export type FraudDecisionStatus =
  | 'auto_allowed'
  | 'auto_blocked'
  | 'pending_review'
  | 'approved'
  | 'rejected';

export interface FraudDecision {
  bookingId: string;
  score: number;
  verdict: FraudVerdict;
  reasons: string[];
  facts: FraudFacts;
  status: FraudDecisionStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/** стартовый статус решения: авто-вердикты закрыты сразу, review ждёт человека */
export function initialStatus(verdict: FraudVerdict): FraudDecisionStatus {
  switch (verdict) {
    case 'block':
      return 'auto_blocked';
    case 'review':
      return 'pending_review';
    default:
      return 'auto_allowed';
  }
}

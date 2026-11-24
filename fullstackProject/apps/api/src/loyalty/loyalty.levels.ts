/**
 * Уровни лояльности «Киноман» (этап 38): чистая логика без I/O —
 * пороги, перки, прогресс. Уровень считается от пожизненных трат
 * (SUM(total_rub) CONFIRMED-броней), как баланс бонусов — от источника,
 * ничего не денормализуем: отмена/возврат брони понижает сумму самим
 * фактом смены статуса.
 *
 * Пороги настраиваются LOYALTY_TIERS_RUB (csv, ₽): прод не трогает
 * дефолт, стендам e2e даёт копеечные значения — тот же приём, что
 * breaker 3/5 c у внешнего справочника.
 */

/** один уровень лестницы: порог входа и перки */
export interface LoyaltyTier {
  /** 0..3 — машинный индекс, уходит и в Тарификатор (loyalty_tier) */
  index: number;
  /** slug для витрины: newcomer | viewer | cinephile | legend */
  code: string;
  /** человекочитаемо: «Киноман» */
  name: string;
  /** пожизненные траты, с которых действует (для Новичка — 0) */
  minSpentRub: number;
  /** прибавка к базовому кэшбэку (env-процент — база Новичка), п.п. */
  cashbackBonusPercent: number;
  /** скидка на заказ кинобара, % */
  barDiscountPercent: number;
  /** надбавки спроса Тарификатора не действуют (demand_high/full) */
  demandMarkupWaived: boolean;
}

/** продовые пороги, ₽: Зритель / Киноман / Легенда экрана */
export const DEFAULT_LOYALTY_THRESHOLDS_RUB = [3000, 10000, 30000];

/**
 * LOYALTY_TIERS_RUB='3000,10000,30000' → [3000, 10000, 30000].
 * Мусор (не числа, не возрастает, нули/минус) — тихий дефолт:
 * конфиг не должен ронять модуль, витрина покажет стандартную лестницу.
 */
export function loyaltyThresholdsFromEnv(
  raw = process.env.LOYALTY_TIERS_RUB,
): number[] {
  if (!raw) return [...DEFAULT_LOYALTY_THRESHOLDS_RUB];
  const parsed = raw
    .split(',')
    .map((chunk) => Number(chunk.trim()))
    .filter((n) => Number.isFinite(n));
  if (
    parsed.length !== DEFAULT_LOYALTY_THRESHOLDS_RUB.length ||
    parsed.some((n) => n <= 0) ||
    parsed.some((n, i) => i > 0 && n <= parsed[i - 1])
  ) {
    return [...DEFAULT_LOYALTY_THRESHOLDS_RUB];
  }
  return parsed;
}

/** неизменная часть лестницы: имена и перки; пороги — параметр */
const TIER_SHAPE: Omit<
  LoyaltyTier,
  'index' | 'minSpentRub'
>[] = [
  {
    code: 'newcomer',
    name: 'Новичок',
    cashbackBonusPercent: 0,
    barDiscountPercent: 0,
    demandMarkupWaived: false,
  },
  {
    code: 'viewer',
    name: 'Зритель',
    cashbackBonusPercent: 2,
    barDiscountPercent: 5,
    demandMarkupWaived: false,
  },
  {
    code: 'cinephile',
    name: 'Киноман',
    cashbackBonusPercent: 5,
    barDiscountPercent: 10,
    demandMarkupWaived: true,
  },
  {
    code: 'legend',
    name: 'Легенда экрана',
    cashbackBonusPercent: 10,
    barDiscountPercent: 15,
    demandMarkupWaived: true,
  },
];

/** лестница уровней с заданными порогами (длина порогов + 1 ступень) */
export function buildLoyaltyTiers(thresholds: number[]): LoyaltyTier[] {
  if (thresholds.length !== TIER_SHAPE.length - 1) {
    thresholds = DEFAULT_LOYALTY_THRESHOLDS_RUB;
  }
  return TIER_SHAPE.map((shape, index) => ({
    ...shape,
    index,
    minSpentRub: index === 0 ? 0 : thresholds[index - 1],
  }));
}

/** текущая лестница: пороги из env или продовый дефолт */
export function loyaltyTiers(): LoyaltyTier[] {
  return buildLoyaltyTiers(loyaltyThresholdsFromEnv());
}

/** индекс уровня по тратам: ровно на пороге — уже новый уровень */
export function tierIndexForSpent(
  spentRub: number,
  tiers: LoyaltyTier[] = loyaltyTiers(),
): number {
  let index = 0;
  for (const tier of tiers) {
    if (spentRub >= tier.minSpentRub) index = tier.index;
  }
  return index;
}

/** прибавка кэшбэка уровня, п.п.: 0 / 2 / 5 / 10 */
export function cashbackBonusPercent(
  tierIndex: number,
  tiers: LoyaltyTier[] = loyaltyTiers(),
): number {
  return tiers[Math.min(Math.max(tierIndex, 0), tiers.length - 1)]
    .cashbackBonusPercent;
}

/** прогресс до следующего уровня: null на вершине лестницы */
export function progressToNext(
  spentRub: number,
  tiers: LoyaltyTier[] = loyaltyTiers(),
): {
  next: LoyaltyTier | null;
  /** сколько ₽ не хватает до порога */
  toNextRub: number;
  /** доля пути между прошлым и следующим порогом, 0..100 */
  progressPercent: number;
} {
  const index = tierIndexForSpent(spentRub, tiers);
  const next = tiers[index + 1] ?? null;
  if (!next) return { next: null, toNextRub: 0, progressPercent: 100 };
  const current = tiers[index];
  const span = next.minSpentRub - current.minSpentRub;
  const done = spentRub - current.minSpentRub;
  return {
    next,
    toNextRub: next.minSpentRub - spentRub,
    // floor, не round: 99,5% при нехватке 1 ₽ не должны показывать
    // «100%» — полоса обманула бы ожиданием перехода здесь и сейчас
    progressPercent: Math.min(
      100,
      Math.max(0, Math.floor((done / span) * 100)),
    ),
  };
}

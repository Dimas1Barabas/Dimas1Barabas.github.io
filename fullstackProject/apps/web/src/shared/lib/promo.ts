/**
 * Промокоды: зеркало чистой логики API (apps/api/src/promos/promo.logic.ts) —
 * превью скидки на экране оплаты и симуляция в демо-режиме считают одинаково.
 */

/** вид скидки — один источник для API-контрактов и демо-движка */
export type PromoKind = 'percent' | 'fixed';

/** допустимые символы кода — как @Matches в DTO API */
export const PROMO_CODE_RE = /^[A-Za-z0-9-]{3,32}$/;

/** единый вид кода: без пробелов по краям, в верхнем регистре */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Скидка по промокоду: percent — с округлением до рубля, fixed не уводит
 * итог в минус (скидка больше суммы = «бесплатно»).
 */
export function promoDiscount(
  totalRub: number,
  kind: PromoKind,
  value: number,
): number {
  if (kind === 'percent') {
    return Math.round((totalRub * value) / 100);
  }
  return Math.min(value, totalRub);
}

import { PromoKind } from './promo.entity';

/** единый вид кода: без пробелов по краям, в верхнем регистре */
export function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Чистая функция скидки — один источник для оплаты (API), превью
 * на экране оплаты и демо-режима (зеркало на фронте).
 * percent — округление до рубля; fixed не уводит итог в минус:
 * скидка больше суммы означает «бесплатно» (итог 0).
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

/**
 * Бонусы: зеркало чистой логики API (apps/api/src/bonus/bonus.logic.ts) —
 * превью списания на экране оплаты и симуляция в демо-режиме считают
 * одинаково. Курс: 1 бонус = 1 ₽, суммы всегда целые.
 */

/** бонусами можно закрыть не больше этой доли чека (после промокода) */
export const BONUS_SPEND_LIMIT = 0.5;

/** кэшбэк: процент от фактически оплаченной суммы, округление вниз */
export function cashbackFor(totalRub: number, percent: number): number {
  return Math.floor((totalRub * percent) / 100);
}

/**
 * Сколько бонусов можно списать при оплате: не больше половины чека
 * и не больше баланса. Math.max — отрицательные входы не дают
 * отрицательного потолка.
 */
export function spendCap(totalRub: number, balance: number): number {
  return Math.max(
    0,
    Math.min(Math.floor(totalRub * BONUS_SPEND_LIMIT), Math.floor(balance)),
  );
}

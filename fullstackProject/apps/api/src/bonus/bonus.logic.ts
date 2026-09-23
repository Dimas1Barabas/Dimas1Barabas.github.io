/**
 * Арифметика бонусной программы — чистые функции, один источник для
 * оплаты (API), превью на экране оплаты и демо-режима (зеркало на
 * фронте). Курс: 1 бонус = 1 ₽, суммы всегда целые.
 */

/** бонусами можно закрыть не больше этой доли чека (после промокода) */
export const BONUS_SPEND_LIMIT = 0.5;

/**
 * Кэшбэк: процент от фактически оплаченной суммы (после промокода и
 * списания бонусов), округление вниз — бонусы целые.
 */
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

/**
 * Баланс пользователя из ledger'а: SUM(accrual) − SUM(spend).
 * Один источник для оплаты (BookingsService.pay) и счёта
 * (GET /bonuses/my). SUM(int) → bigint, pg-драйвер отдаёт строкой.
 */
export const BONUS_BALANCE_SQL = `
  SELECT COALESCE(SUM(CASE kind WHEN 'accrual' THEN amount ELSE -amount END), 0) AS balance
    FROM bonus_transactions WHERE user_id = $1`;

/** строки брони — источник разворота бонусов при отмене */
export const BONUS_BOOKING_ROWS_SQL = `
  SELECT reason, amount FROM bonus_transactions WHERE booking_id = $1`;

/**
 * Процент кэшбэка по подтверждённой брони: доля от фактически
 * оплаченной суммы (после промокода и списания бонусов).
 *
 * Читается из process.env напрямую, без ConfigService — по образцу
 * payment-timeout.ts: значение нужно сервису в рантайме, дефолт в коде.
 */
export const DEFAULT_CASHBACK_PERCENT = 5;

export function cashbackPercent(): number {
  const raw = Number.parseFloat(process.env.BONUS_CASHBACK_PERCENT ?? '');
  return Number.isFinite(raw) && raw >= 0 && raw <= 100
    ? raw
    : DEFAULT_CASHBACK_PERCENT;
}

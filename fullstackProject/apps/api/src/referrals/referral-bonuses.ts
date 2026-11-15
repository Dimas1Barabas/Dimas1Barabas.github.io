/**
 * Размеры реферальных бонусов: пригласившему — за первую оплаченную
 * бронь друга, другу — welcome за ту же оплату. Читается из
 * process.env напрямую, без ConfigService — по образцу
 * cashback-percent.ts: значение нужно сервису в рантайме, дефолт в коде.
 */
export const DEFAULT_REFERRAL_BONUS_INVITER = 300;
export const DEFAULT_REFERRAL_BONUS_FRIEND = 100;

function envBonus(name: string, fallback: number): number {
  const raw = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(raw) && raw >= 0 && Number.isInteger(raw)
    ? raw
    : fallback;
}

export function referralBonusInviter(): number {
  return envBonus('REFERRAL_BONUS_INVITER', DEFAULT_REFERRAL_BONUS_INVITER);
}

export function referralBonusFriend(): number {
  return envBonus('REFERRAL_BONUS_FRIEND', DEFAULT_REFERRAL_BONUS_FRIEND);
}

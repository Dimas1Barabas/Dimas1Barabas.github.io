/**
 * Чистая логика страницы «Пригласить»: маскировка email друга
 * (адрес принадлежит пригласившему только наполовину — показываем
 * первую букву и домен) и итоги по списку приглашённых.
 */

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0]}***${domain}`;
}

export type InvitedRow = {
  name: string;
  email: string;
  paid: boolean;
};

export type ReferralTotals = {
  /** сколько людей зарегистрировалось по коду */
  invited: number;
  /** у скольких из них первая бронь оплачена (бонус уже начислен) */
  paid: number;
  /** сколько реферальных бонусов упало на счёт пригласившего */
  earned: number;
};

export function referralTotals(
  invited: InvitedRow[],
  earned: number,
): ReferralTotals {
  return {
    invited: invited.length,
    paid: invited.filter((i) => i.paid).length,
    earned,
  };
}

/**
 * Сколько реферальных бонусов начислено пригласившему: SUM по ledger
 * от источника, SUM(int) → bigint, pg-драйвер отдаёт строкой — как
 * BONUS_BALANCE_SQL в bonus.logic.
 */
export const REFERRAL_EARNED_SQL = `
  SELECT COALESCE(SUM(amount), 0) AS earned
    FROM bonus_transactions
   WHERE user_id = $1 AND kind = 'accrual' AND reason = 'referral'`;

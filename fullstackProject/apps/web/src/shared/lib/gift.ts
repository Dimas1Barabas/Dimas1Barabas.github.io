/**
 * Зеркало gifts.logic API для демо-режима (как promo.ts и bonus.ts):
 * те же границы номинала, нормализация кода и арифметика списания —
 * демо-движок ведёт себя ровно как транзакция оплаты в API.
 */

/** номиналы — круглые суммы, какие печатают на подарочных картах */
export const GIFT_NOMINAL_MIN = 500;
export const GIFT_NOMINAL_MAX = 50_000;
export const GIFT_NOMINAL_STEP = 100;
/** срок жизни карты с момента покупки */
export const GIFT_TTL_DAYS = 365;

/** коды: Crockford base32 — без I, L, O, U (путаются при чтении) */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const GIFT_CODE_PREFIX = 'GIFT-';

/** ошибка номинала или null — тот же текст, что отдаёт API */
export function nominalError(nominalRub: number): string | null {
  if (!Number.isInteger(nominalRub)) {
    return 'Номинал — целое число рублей';
  }
  if (nominalRub < GIFT_NOMINAL_MIN || nominalRub > GIFT_NOMINAL_MAX) {
    return `Номинал — от ${GIFT_NOMINAL_MIN} до ${GIFT_NOMINAL_MAX} ₽`;
  }
  if (nominalRub % GIFT_NOMINAL_STEP !== 0) {
    return `Номинал — круглая сумма, кратная ${GIFT_NOMINAL_STEP} ₽`;
  }
  return null;
}

/** нормализация ввода: обводки пробелами и регистр */
export function normalizeGiftCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** новый код карты: GIFT- + 8 символов алфавита (Math.random — демо) */
export function generateGiftCode(): string {
  let body = '';
  for (let i = 0; i < 8; i++) {
    body += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return GIFT_CODE_PREFIX + body;
}

/** сколько снять с карты: не больше остатка чека и остатка карты */
export function giftSpendAmount(
  remainingRub: number,
  restRub: number,
): number {
  return Math.max(0, Math.min(remainingRub, restRub));
}

/** истекла ли карта на момент now */
export function giftExpired(expiresAt: string, now = Date.now()): boolean {
  return Date.parse(expiresAt) <= now;
}

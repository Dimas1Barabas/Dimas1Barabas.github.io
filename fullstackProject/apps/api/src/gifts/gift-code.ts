import { randomInt } from 'node:crypto';
import { CODE_ALPHABET } from '../users/referral-code';

/**
 * Коды сертификатов: «GIFT-» + 8 символов Crockford base32 (алфавит
 * реферальных кодов — без I, L, O, U, путающихся при чтении с экрана и
 * диктовке по телефону). Префикс отличает подарочную карту от промокода
 * и кода приглашения в интерфейсе кассы; 32^8 ≈ 1,1 трлн комбинаций,
 * коллизии добивает uq_gift_certificates_code с ретраем при покупке.
 */
export const GIFT_CODE_PREFIX = 'GIFT-';
export const GIFT_CODE_BODY_LENGTH = 8;

export function generateGiftCode(): string {
  let body = '';
  for (let i = 0; i < GIFT_CODE_BODY_LENGTH; i++) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return GIFT_CODE_PREFIX + body;
}

/** активация по коду: нормализация ввода — регистр и обводки пробелами */
export function normalizeGiftCode(raw: string): string {
  return raw.trim().toUpperCase();
}

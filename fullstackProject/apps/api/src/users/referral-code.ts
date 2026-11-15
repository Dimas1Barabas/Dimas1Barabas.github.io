import { randomInt } from 'node:crypto';

/**
 * Коды приглашений: 8 символов алфавита Crockford base32 — без I, L,
 * O, U (1/I/L и 0/O путаются при чтении с экрана). 32^8 ≈ 1,1 трлн
 * комбинаций: коллизии маловероятны, добивает unique-констрейнт
 * с ретраем в UsersService.register.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REFERRAL_CODE_LENGTH = 8;

export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** регистрация по коду: нормализация ввода — регистр и обводки пробелами */
export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase();
}

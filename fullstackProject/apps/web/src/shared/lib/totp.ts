/**
 * TOTP (RFC 6238) — зеркало apps/api/src/twofactor/totp.ts для демо-
 * режима: та же арифметика (base32 RFC 4648 → HMAC-SHA1 → усечение
 * RFC 4226, 6 цифр, шаг 30 с, окно ±1), те же тест-векторы. Векторы
 * совпадают — код приложения и код демо-движка неотличимы.
 */

import { hmacSha1Bytes } from './sha1';

export const TOTP_STEP_SEC = 30;
export const TOTP_WINDOW = 1;
export const TOTP_DIGITS = 6;

/** алфавит кодов реферал/гифт — без путающихся I/L/O/U */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** байты → base32 (RFC 4648, без паддинга «=») */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** base32 → байты; мусорные символы — ошибка */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`не base32-символ: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** новый секрет: 20 случайных байт в base32 (32 символа) */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/** HOTP по RFC 4226: HMAC-SHA1(key, counter) → динамическое усечение */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = TOTP_DIGITS,
): string {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const digest = hmacSha1Bytes(secret, msg);
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** TOTP: HOTP со счётчиком времени floor(unixSec / 30) */
export function totp(secretBase32: string, at: Date = new Date()): string {
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SEC);
  return hotp(base32Decode(secretBase32), counter);
}

/** сверка кода с окном ±1 шаг (дрейф телефона ±30 с прощается) */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date = new Date(),
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SEC);
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    if (hotp(secret, counter + drift) === code) return true;
  }
  return false;
}

/** otpauth://-ссылка для QR — посимвольно та же, что в API */
export function otpauthUri(input: {
  secretBase32: string;
  email: string;
  issuer?: string;
}): string {
  const issuer = input.issuer ?? 'CineBooking';
  const label = encodeURIComponent(`${issuer}:${input.email}`);
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** backup-код XXXX-XXXX тем же алфавитом, что и API */
export function generateBackupCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let body = '';
  for (let i = 0; i < 8; i++) {
    body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i === 3) body += '-';
  }
  return body;
}

/** пользовательский ввод: регистр и разделители прощаются */
export function normalizeBackupCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '');
}

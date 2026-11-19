import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CODE_ALPHABET } from '../users/referral-code';

/**
 * TOTP по RFC 6238 без библиотек: HMAC-SHA1 из node:crypto, шаг 30 с,
 * 6 цифр, окно ±1 шаг (часовой дрейф телефона ±30 с прощается) — так
 * работает Google Authenticator и любые совместимые приложения.
 * Секрет — 20 байт в base32 (RFC 4648 без паддинга), как принято
 * у аутентификаторов.
 */

export const TOTP_STEP_SEC = 30;
/** 20 байт = 160 бит — рекомендация RFC 4226 для HMAC-SHA1 */
export const TOTP_SECRET_BYTES = 20;
/** сколько шагов вокруг текущего принимать (±1 = ±30 с) */
export const TOTP_WINDOW = 1;
export const TOTP_DIGITS = 6;

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

/** base32 → байты; паддинг и мусорные символы — ошибка (секрет из БД валиден) */
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
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/**
 * HOTP по RFC 4226: HMAC-SHA1(key, counter) → динамическое усечение →
 * N цифр. Тест-векторы RFC — в totp.spec (и web-зеркало сверяется
 * с теми же векторами).
 */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number = TOTP_DIGITS,
): string {
  // counter — 8 байт big-endian
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const digest = createHmac('sha1', secret).update(msg).digest();
  // динамическое усечение: младшие 4 бита последнего байта — смещение
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

/** сверка кода с окном ±1 шаг; сравнение постоянное по времени */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date = new Date(),
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at.getTime() / 1000 / TOTP_STEP_SEC);
  for (let drift = -TOTP_WINDOW; drift <= TOTP_WINDOW; drift++) {
    const expected = Buffer.from(hotp(secret, counter + drift), 'utf8');
    if (
      expected.length === code.length &&
      timingSafeEqual(expected, Buffer.from(code, 'utf8'))
    ) {
      return true;
    }
  }
  return false;
}

/** otpauth://-ссылка для QR: её сканирует приложение-аутентификатор */
export function otpauthUri(input: {
  secretBase32: string;
  email: string;
  issuer?: string;
}): string {
  const issuer = input.issuer ?? 'CineBooking';
  // encodeURIComponent для меток — ГОСТ-практика RFC 6238: label = issuer:account
  const label = encodeURIComponent(`${issuer}:${input.email}`);
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer,
    // 6 цифр, SHA-1, шаг 30 с — параметры по умолчанию, но явные
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── backup-коды: одноразовые, на случай утери телефона ──────────────

/** формат XXXX-XXXX из алфавита без похожих I/L/O/U (как коды реферал/гифт) */
export function generateBackupCode(): string {
  let body = '';
  const bytes = randomBytes(8);
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

/** в БД — только хэш нормализованного кода (как refresh-токены) */
export function backupCodeHash(raw: string): string {
  return createHash('sha256').update(normalizeBackupCode(raw)).digest('hex');
}

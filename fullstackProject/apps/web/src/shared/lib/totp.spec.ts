import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from './totp';

/**
 * Те же векторы, что у API (apps/api/src/twofactor/totp.spec.ts):
 * RFC 4226 счётчики 0…9 и RFC 6238 таймстемпы — зеркало обязано
 * выдавать те же коды, что прод-реализация на node:crypto.
 */

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32', () => {
  it('кругосветка байтов', () => {
    for (const len of [1, 5, 20]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37) % 256);
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });

  it('RFC-секрет = ASCII «12345678901234567890»', () => {
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET))).toBe(
      '12345678901234567890',
    );
  });
});

describe('HOTP: векторы RFC 4226', () => {
  const rfc4226 = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  it.each(rfc4226.map((code, counter) => ({ counter, code })))(
    'counter $counter → $code',
    ({ counter, code }) => {
      expect(hotp(base32Decode(RFC_SECRET), counter)).toBe(code);
    },
  );
});

describe('TOTP: векторы RFC 6238 (6 цифр)', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('T=%d → %s', (sec, six) => {
    expect(totp(RFC_SECRET, new Date(sec * 1000))).toBe(six);
  });
});

describe('verifyTotp: окно ±1 шаг', () => {
  const at = new Date('2026-11-19T12:00:00Z');
  const code = totp(RFC_SECRET, at);

  it('точный и соседние ±30 с верны', () => {
    expect(verifyTotp(RFC_SECRET, code, at)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() - 30_000))).toBe(true);
  });

  it('±90 с и мусор — false', () => {
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 90_000))).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12ab45', at)).toBe(false);
  });
});

describe('otpauth-ссылка — посимвольно как в API', () => {
  it('issuer:email, SHA1/6/30', () => {
    expect(otpauthUri({ secretBase32: RFC_SECRET, email: 'alice@x.io' })).toBe(
      'otpauth://totp/CineBooking%3Aalice%40x.io' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=CineBooking&algorithm=SHA1&digits=6&period=30',
    );
  });
});

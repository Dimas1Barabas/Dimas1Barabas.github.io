import {
  base32Decode,
  base32Encode,
  backupCodeHash,
  generateBackupCode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from './totp';

/**
 * Векторы RFC — эталон правильности всей цепочки base32 → HMAC-SHA1 →
 * усечение → код. Те же векторы обязан повторять web-зеркало
 * (shared/lib/totp) — паритет, как у sha256 и раскладки Тарификатора.
 */

/** секрет из RFC 4226/6238: ASCII «12345678901234567890» */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32 (RFC 4648)', () => {
  it('кодирует и декодирует круглосуточно', () => {
    for (const len of [1, 5, 20, 32]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37) % 256);
      const round = base32Decode(base32Encode(bytes));
      expect(round).toEqual(bytes);
    }
  });

  it('RFC-секрет декодируется в ASCII «12345678901234567890»', () => {
    expect(Buffer.from(base32Decode(RFC_SECRET)).toString('ascii')).toBe(
      '12345678901234567890',
    );
  });

  it('известный вектор: байты foo → MZXW6=== без паддинга', () => {
    expect(base32Encode(Buffer.from('foo', 'ascii'))).toBe('MZXW6');
  });

  it('мусорный символ — ошибка декодирования', () => {
    expect(() => base32Decode('ABC1!')).toThrow(/не base32/);
  });
});

describe('HOTP (RFC 4226, приложение D)', () => {
  // 6-значные коды счётчиков 0…9 для ключа «12345678901234567890»
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

describe('TOTP (RFC 6238, приложение B)', () => {
  // 8-значные усечения для SHA1-секретa; 6-значный вариант = хвост
  const rfc6238: Array<[sec: number, eight: string, six: string]> = [
    [59, '94287082', '287082'],
    [1111111109, '07081804', '081804'],
    [1111111111, '14050471', '050471'],
    [1234567890, '89005924', '005924'],
    [2000000000, '69279037', '279037'],
    [20000000000, '65353130', '353130'],
  ];

  it.each(rfc6238)('T=%d с → 8 цифр %s / 6 цифр %s', (sec, eight, six) => {
    const at = new Date(sec * 1000);
    expect(hotp(base32Decode(RFC_SECRET), Math.floor(sec / 30), 8)).toBe(eight);
    expect(totp(RFC_SECRET, at)).toBe(six);
  });
});

describe('verifyTotp: окно и формат', () => {
  const at = new Date('2026-11-19T12:00:00Z');
  // TOTP-step границы: 12:00:00 — ровно на шаге; соседние коды — ±30 с
  const code = totp(RFC_SECRET, at);

  it('точный код верен', () => {
    expect(verifyTotp(RFC_SECRET, code, at)).toBe(true);
  });

  it('дрейф ±30 с прощается (окно ±1 шаг)', () => {
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 30_000))).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() - 30_000))).toBe(true);
  });

  it('дрейф ±90 с уже не проходит', () => {
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 90_000))).toBe(false);
  });

  it('не-цифры и не-6-значные коды не ходят в сравнение', () => {
    expect(verifyTotp(RFC_SECRET, 'abcdef', at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345', at)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '1234567', at)).toBe(false);
  });

  it('чужой секрет не подтверждается кодом первого', () => {
    const other = generateTotpSecret();
    expect(verifyTotp(other, code, at)).toBe(false);
  });
});

describe('секреты и otpauth-ссылка', () => {
  it('генерация: 32 символа base32, каждый — новый', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
  });

  it('otpauth-URI: issuer:email, параметры SHA1/6/30', () => {
    const uri = otpauthUri({ secretBase32: RFC_SECRET, email: 'alice@x.io' });
    expect(uri).toBe(
      'otpauth://totp/CineBooking%3Aalice%40x.io' +
        '?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=CineBooking&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('backup-коды', () => {
  it('формат XXXX-XXXX из алфавита без I/L/O/U', () => {
    for (let i = 0; i < 20; i++) {
      expect(generateBackupCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });

  it('нормализация прощает регистр, пробелы и тире', () => {
    expect(backupCodeHash(' abcd-2345 ')).toBe(backupCodeHash('ABCD 2345'));
    expect(backupCodeHash('AbCd2345')).toBe(backupCodeHash('abcd-2345'));
  });

  it('хэш — sha256 нормализованного кода', () => {
    expect(backupCodeHash('abcd-2345')).toHaveLength(64);
    expect(backupCodeHash('abcd-2345')).toMatch(/^[0-9a-f]{64}$/);
  });
});

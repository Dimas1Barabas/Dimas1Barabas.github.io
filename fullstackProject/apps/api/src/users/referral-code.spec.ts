import {
  CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  generateReferralCode,
  normalizeReferralCode,
} from './referral-code';

describe('referral-code', () => {
  it('генерирует код заданной длины из алфавита Crockford base32', () => {
    const code = generateReferralCode();
    expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
  });

  it('алфавит без I/L/O/U — 1/I/L и 0/O не путаются при чтении с экрана', () => {
    const banned = ['I', 'L', 'O', 'U'];
    for (const ch of banned) expect(CODE_ALPHABET).not.toContain(ch);
    expect(CODE_ALPHABET).not.toMatch(/(.)\1/); // без дублей в самом алфавите
  });

  it('коды не повторяются на серии — 1 трлн комбинаций на практике', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateReferralCode()));
    expect(codes.size).toBe(500);
  });

  it('normalize приводит регистр и обрезает обводки', () => {
    expect(normalizeReferralCode('  ab2cd3ef ')).toBe('AB2CD3EF');
    expect(normalizeReferralCode('qwerty12')).toBe('QWERTY12');
  });
});

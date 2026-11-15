import { maskEmail, referralTotals } from './referrals.logic';

describe('maskEmail', () => {
  it('оставляет первую букву локальной части и домен целиком', () => {
    expect(maskEmail('bob@example.com')).toBe('b***@example.com');
    expect(maskEmail('anna.long@gmail.com')).toBe('a***@gmail.com');
  });

  it('однобуквенный локал тоже маскируется', () => {
    expect(maskEmail('x@example.com')).toBe('x***@example.com');
  });

  it('мусор без @ — глухая маска, без паники', () => {
    expect(maskEmail('не-email')).toBe('***');
    expect(maskEmail('@domain.only')).toBe('***');
  });
});

describe('referralTotals', () => {
  const row = (paid: boolean) => ({
    name: 'Друг',
    email: 'f***@example.com',
    paid,
  });

  it('считает пришедших, оплативших и заработанное', () => {
    expect(referralTotals([row(true), row(false), row(true)], 600)).toEqual({
      invited: 3,
      paid: 2,
      earned: 600,
    });
  });

  it('пустой список — нули', () => {
    expect(referralTotals([], 0)).toEqual({ invited: 0, paid: 0, earned: 0 });
  });
});

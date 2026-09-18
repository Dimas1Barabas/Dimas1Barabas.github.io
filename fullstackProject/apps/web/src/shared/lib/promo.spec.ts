import { describe, expect, it } from 'vitest';
import {
  PROMO_CODE_RE,
  normalizePromoCode,
  promoDiscount,
} from './promo';

describe('promo (shared/lib)', () => {
  describe('normalizePromoCode', () => {
    it('обрезает пробелы и поднимает регистр', () => {
      expect(normalizePromoCode('  cine-10 ')).toBe('CINE-10');
      expect(normalizePromoCode('summer300')).toBe('SUMMER300');
    });
  });

  describe('PROMO_CODE_RE', () => {
    it('пускает латиницу, цифры и дефис (3–32)', () => {
      expect(PROMO_CODE_RE.test('CINE10')).toBe(true);
      expect(PROMO_CODE_RE.test('c-1')).toBe(true);
    });

    it('режет кириллицу, пробелы внутри и короткие коды', () => {
      expect(PROMO_CODE_RE.test('КИНО10')).toBe(false);
      expect(PROMO_CODE_RE.test('cine 10')).toBe(false);
      expect(PROMO_CODE_RE.test('ab')).toBe(false);
    });
  });

  describe('promoDiscount', () => {
    it('процент от суммы, округление до рубля', () => {
      expect(promoDiscount(1000, 'percent', 10)).toBe(100);
      expect(promoDiscount(999, 'percent', 10)).toBe(100); // 99.9 → 100
      expect(promoDiscount(494, 'percent', 10)).toBe(49); // 49.4 → 49
    });

    it('фикс клампится к сумме: больше суммы — бронь бесплатно', () => {
      expect(promoDiscount(1000, 'fixed', 300)).toBe(300);
      expect(promoDiscount(1000, 'fixed', 5000)).toBe(1000);
      expect(promoDiscount(0, 'fixed', 300)).toBe(0);
    });
  });
});

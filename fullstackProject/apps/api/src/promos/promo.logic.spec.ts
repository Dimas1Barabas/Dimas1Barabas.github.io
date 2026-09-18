import { normalizePromoCode, promoDiscount } from './promo.logic';

describe('promo.logic (unit)', () => {
  describe('normalizePromoCode', () => {
    it('обрезает пробелы и поднимает регистр', () => {
      expect(normalizePromoCode('  cine-10 ')).toBe('CINE-10');
      expect(normalizePromoCode('summer300')).toBe('SUMMER300');
    });
  });

  describe('promoDiscount', () => {
    it('процент от суммы', () => {
      expect(promoDiscount(1000, 'percent', 10)).toBe(100);
      expect(promoDiscount(700, 'percent', 50)).toBe(350);
    });

    it('процент округляется до рубля', () => {
      expect(promoDiscount(999, 'percent', 10)).toBe(100); // 99.9 → 100
      expect(promoDiscount(495, 'percent', 10)).toBe(50); // 49.5 → 50
      expect(promoDiscount(494, 'percent', 10)).toBe(49); // 49.4 → 49
    });

    it('фикс не уводит итог в минус: скидка больше суммы — бронь бесплатно', () => {
      expect(promoDiscount(1000, 'fixed', 300)).toBe(300);
      expect(promoDiscount(1000, 'fixed', 5000)).toBe(1000);
    });

    it('от нулевой суммы скидки нет', () => {
      expect(promoDiscount(0, 'percent', 10)).toBe(0);
      expect(promoDiscount(0, 'fixed', 300)).toBe(0);
    });
  });
});

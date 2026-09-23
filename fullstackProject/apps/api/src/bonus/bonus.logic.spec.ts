import { BONUS_SPEND_LIMIT, cashbackFor, spendCap } from './bonus.logic';

describe('bonus.logic (unit)', () => {
  describe('cashbackFor', () => {
    it('процент от фактически оплаченной суммы', () => {
      expect(cashbackFor(1000, 5)).toBe(50);
      expect(cashbackFor(600, 10)).toBe(60);
    });

    it('округляется вниз — бонусы целые', () => {
      expect(cashbackFor(999, 5)).toBe(49); // 49.95 → 49
      expect(cashbackFor(199, 5)).toBe(9); // 9.95 → 9
    });

    it('от нулевой оплаты кэшбэка нет', () => {
      expect(cashbackFor(0, 5)).toBe(0);
    });
  });

  describe('spendCap', () => {
    it('лимит — половина чека, когда баланса хватает', () => {
      expect(BONUS_SPEND_LIMIT).toBe(0.5);
      expect(spendCap(1000, 5000)).toBe(500);
      expect(spendCap(999, 5000)).toBe(499); // 499.5 → вниз
    });

    it('баланс режет потолок', () => {
      expect(spendCap(1000, 120)).toBe(120);
      expect(spendCap(1000, 0)).toBe(0);
    });

    it('нулевой или копеечный чек — списывать нечего', () => {
      expect(spendCap(0, 500)).toBe(0);
      expect(spendCap(1, 500)).toBe(0); // floor(0.5) = 0
    });
  });
});

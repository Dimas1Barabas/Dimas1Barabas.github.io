import { describe, expect, it } from 'vitest';
import { BONUS_SPEND_LIMIT, cashbackFor, spendCap } from './bonus';

/** зеркало юнит-тестов API — фронт и бэк считают одинаково */
describe('shared/lib/bonus', () => {
  describe('cashbackFor', () => {
    it('процент от оплаченной суммы, округление вниз', () => {
      expect(cashbackFor(1000, 5)).toBe(50);
      expect(cashbackFor(999, 5)).toBe(49);
      expect(cashbackFor(0, 5)).toBe(0);
    });
  });

  describe('spendCap', () => {
    it('лимит — половина чека, когда баланса хватает', () => {
      expect(BONUS_SPEND_LIMIT).toBe(0.5);
      expect(spendCap(1000, 5000)).toBe(500);
      expect(spendCap(999, 5000)).toBe(499);
    });

    it('баланс режет потолок', () => {
      expect(spendCap(1000, 120)).toBe(120);
      expect(spendCap(1000, 0)).toBe(0);
      expect(spendCap(1, 500)).toBe(0); // floor(0.5) = 0
    });
  });
});

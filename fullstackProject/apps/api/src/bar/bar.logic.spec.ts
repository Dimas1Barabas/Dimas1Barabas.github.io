import { BadRequestException } from '@nestjs/common';
import {
  barDiscountRub,
  barTotal,
  BarOutOfStockError,
  MAX_QTY_PER_ITEM,
  statusRank,
  validateBarOrder,
} from './bar.logic';

describe('validateBarOrder', () => {
  it('пропускает корректный заказ', () => {
    expect(() =>
      validateBarOrder([
        { itemId: 'a', qty: 1 },
        { itemId: 'b', qty: MAX_QTY_PER_ITEM },
      ]),
    ).not.toThrow();
  });

  it('запрещает дубль позиции — количество живёт в qty, не в повторах строк', () => {
    expect(() =>
      validateBarOrder([
        { itemId: 'a', qty: 1 },
        { itemId: 'a', qty: 2 },
      ]),
    ).toThrow(BadRequestException);
  });

  it.each([0, -1, 1.5, MAX_QTY_PER_ITEM + 1])(
    'отклоняет qty=%p (нужно целое 1…10)',
    (qty) => {
      expect(() => validateBarOrder([{ itemId: 'a', qty }])).toThrow(
        BadRequestException,
      );
    },
  );
});

describe('barTotal', () => {
  it('складывает позиции по снимкам цен', () => {
    expect(
      barTotal([
        { priceRub: 340, qty: 2 },
        { priceRub: 220, qty: 1 },
        { priceRub: 890, qty: 3 },
      ]),
    ).toBe(340 * 2 + 220 + 890 * 3);
  });

  it('пустой состав — 0', () => {
    expect(barTotal([])).toBe(0);
  });
});

describe('barDiscountRub', () => {
  it('скидка уровня — floor до целого рубля: 10% от 860 = 86', () => {
    expect(barDiscountRub(860, 10)).toBe(86);
  });

  it('дробная скидка не чеканит копейки: 5% от 890 = 44,5 → 44', () => {
    expect(barDiscountRub(890, 5)).toBe(44);
  });

  it('Новичок (0%) и мусорный минус — без пересчёта', () => {
    expect(barDiscountRub(860, 0)).toBe(0);
    expect(barDiscountRub(860, -5)).toBe(0);
  });

  it('сумма позиций минус скидка = итог к оплате (аудит заказа)', () => {
    const positions = [
      { priceRub: 320, qty: 2 },
      { priceRub: 220, qty: 1 },
    ];
    const gross = barTotal(positions);
    expect(gross - barDiscountRub(gross, 15)).toBe(731); // 860 − 129
  });
});

describe('BarOutOfStockError', () => {
  it('несёт имя позиции и честный остаток для 409', () => {
    const err = new BarOutOfStockError('Вода газированная 0,5 л', 0);
    expect(err.itemName).toBe('Вода газированная 0,5 л');
    expect(err.left).toBe(0);
    expect(err.message).toContain('Вода газированная 0,5 л');
    expect(err.message).toContain('0 порц.');
  });
});

describe('statusRank', () => {
  it('жизненный цикл монотонен: NEW → PREPARING → READY → PICKED_UP', () => {
    expect(statusRank('NEW')).toBeLessThan(statusRank('PREPARING'));
    expect(statusRank('PREPARING')).toBeLessThan(statusRank('READY'));
    expect(statusRank('READY')).toBeLessThan(statusRank('PICKED_UP'));
  });

  it('отмена терминальна: опоздавшее «готово» не оживит её', () => {
    expect(statusRank('CANCELLED')).toBeGreaterThan(statusRank('READY'));
  });
});

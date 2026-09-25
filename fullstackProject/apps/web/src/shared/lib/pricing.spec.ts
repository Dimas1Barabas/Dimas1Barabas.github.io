import { describe, expect, it } from 'vitest';
import { quoteSession } from '@/shared/lib/pricing';

/**
 * Векторы зеркала сверены с доменными тестами Go-сервиса
 * (services/pricing-service/internal/domain/pricing_test.go):
 * демо и live не расходятся в цене ни на рубль.
 */

// вторник 2026-09-22, суббота 2026-09-26 — как в Go-таблице
const tue = (h: number) => new Date(2026, 8, 22, h, 0, 0, 0).toISOString();
const sat = (h: number) => new Date(2026, 8, 26, h, 0, 0, 0).toISOString();

function quote(sessionAt: string, base: number, occupied: number) {
  return quoteSession({
    sessionId: 's-1',
    startsAt: sessionAt,
    basePriceRub: base,
    occupied,
    capacity: 80,
  });
}

describe('quoteSession — зеркало Тарификатора', () => {
  it('день буднего, середина занятости — база без факторов', () => {
    const q = quote(tue(14), 400, 30); // 37%
    expect(q.priceRub).toBe(400);
    expect(q.factors).toEqual([]);
  });

  it('утро буднего — −20%', () => {
    const q = quote(tue(10), 400, 30);
    expect(q.priceRub).toBe(320);
    expect(q.factors.map((f) => f.code)).toEqual(['morning']);
  });

  it('вечер буднего — +20%; ночь после 23 — база', () => {
    expect(quote(tue(19), 400, 30).priceRub).toBe(480);
    expect(quote(tue(23), 400, 30).factors.map((f) => f.code)).toEqual([]);
  });

  it('выходной — +10%; вечер выходного — оба фактора', () => {
    expect(quote(sat(14), 400, 30).priceRub).toBe(440);
    const q = quote(sat(19), 400, 30);
    expect(q.factors.map((f) => f.code)).toEqual(['evening', 'weekend']);
    expect(q.priceRub).toBe(530); // 400 × 1.2 × 1.1 = 528 → 530
  });

  it('спрос: аншлаг сильнее высокого, пустой зал дешевле', () => {
    expect(quote(tue(14), 400, 70).factors.map((f) => f.code)).toEqual(['demand_full']); // 87%
    expect(quote(tue(14), 400, 70).priceRub).toBe(500);
    expect(quote(tue(14), 400, 45).factors.map((f) => f.code)).toEqual(['demand_high']); // 56%
    expect(quote(tue(14), 400, 10).priceRub).toBe(360); // 12% — «зал почти пуст»
  });

  it('граница низкого спроса (ровно 20%) — фактора нет', () => {
    expect(quote(tue(14), 400, 16).factors).toEqual([]);
  });

  it('полный фарш: вечер субботы аншлаг', () => {
    const q = quote(sat(19), 450, 80);
    expect(q.factors.map((f) => f.code)).toEqual(['evening', 'weekend', 'demand_full']);
    expect(q.priceRub).toBe(740); // 450 × 1.65 = 742.5 → 740
  });

  it('цена кратна десяти', () => {
    expect(quote(tue(14), 335, 30).priceRub).toBe(340);
  });

  it('занятость зажимается в ёмкость зала', () => {
    const q = quote(tue(14), 400, 120);
    expect(q.occupied).toBe(80);
    expect(quote(tue(14), 400, -5).occupied).toBe(0);
  });
});

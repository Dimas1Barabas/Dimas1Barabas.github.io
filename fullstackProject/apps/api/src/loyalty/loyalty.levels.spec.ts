import {
  DEFAULT_LOYALTY_THRESHOLDS_RUB,
  buildLoyaltyTiers,
  cashbackBonusPercent,
  loyaltyThresholdsFromEnv,
  progressToNext,
  tierIndexForSpent,
} from './loyalty.levels';

describe('loyaltyThresholdsFromEnv', () => {
  const swap = (value: string | undefined) => {
    const orig = process.env.LOYALTY_TIERS_RUB;
    if (value === undefined) delete process.env.LOYALTY_TIERS_RUB;
    else process.env.LOYALTY_TIERS_RUB = value;
    return () => {
      if (orig === undefined) delete process.env.LOYALTY_TIERS_RUB;
      else process.env.LOYALTY_TIERS_RUB = orig;
    };
  };

  it('нет переменной — продовый дефолт', () => {
    const restore = swap(undefined);
    expect(loyaltyThresholdsFromEnv()).toEqual(DEFAULT_LOYALTY_THRESHOLDS_RUB);
    restore();
  });

  it('csv с пробелами — чистые числа', () => {
    const restore = swap(' 100, 300 , 900 ');
    expect(loyaltyThresholdsFromEnv()).toEqual([100, 300, 900]);
    restore();
  });

  it('мусор молча падает на дефолт: не три числа, не возрастает, нули', () => {
    for (const bad of ['100,300', '3000,1000,500', '0,100,200', 'a,b,c', '']) {
      const restore = swap(bad || '');
      // Jest toEqual не принимает сообщение — фиксируем вход в data
      const got = loyaltyThresholdsFromEnv();
      expect([bad, got]).toEqual([bad, DEFAULT_LOYALTY_THRESHOLDS_RUB]);
      restore();
    }
  });
});

describe('tierIndexForSpent', () => {
  const tiers = buildLoyaltyTiers([100, 300, 900]);

  it('ровно на пороге — уже новый уровень', () => {
    expect(tierIndexForSpent(0, tiers)).toBe(0);
    expect(tierIndexForSpent(99, tiers)).toBe(0);
    expect(tierIndexForSpent(100, tiers)).toBe(1);
    expect(tierIndexForSpent(899, tiers)).toBe(2);
    expect(tierIndexForSpent(900, tiers)).toBe(3);
    expect(tierIndexForSpent(100000, tiers)).toBe(3);
  });

  it('лестница несёт перки по сценариям этапа', () => {
    expect(tiers.map((t) => t.code)).toEqual([
      'newcomer',
      'viewer',
      'cinephile',
      'legend',
    ]);
    // кэшбэк-прибавка и скидка бара растут ступенчато
    expect(tiers.map((t) => t.cashbackBonusPercent)).toEqual([0, 2, 5, 10]);
    expect(tiers.map((t) => t.barDiscountPercent)).toEqual([0, 5, 10, 15]);
    // надбавки спроса гаснут с Киномана
    expect(tiers.map((t) => t.demandMarkupWaived)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('cashbackBonusPercent', () => {
  const tiers = buildLoyaltyTiers([100, 300, 900]);

  it('прибавка уровня поверх базового процента', () => {
    expect(cashbackBonusPercent(0, tiers)).toBe(0);
    expect(cashbackBonusPercent(1, tiers)).toBe(2);
    expect(cashbackBonusPercent(3, tiers)).toBe(10);
  });

  it('вышедший за границы индекс зажимается, а не падает', () => {
    expect(cashbackBonusPercent(-1, tiers)).toBe(0);
    expect(cashbackBonusPercent(99, tiers)).toBe(10);
  });
});

describe('progressToNext', () => {
  const tiers = buildLoyaltyTiers([100, 300, 900]);

  it('середина ступени: остаток и доля пути', () => {
    expect(progressToNext(0, tiers)).toEqual({
      next: tiers[1],
      toNextRub: 100,
      progressPercent: 0,
    });
    expect(progressToNext(50, tiers)).toEqual({
      next: tiers[1],
      toNextRub: 50,
      progressPercent: 50,
    });
  });

  it('вершина лестницы — next:null, полный прогресс', () => {
    expect(progressToNext(900, tiers)).toEqual({
      next: null,
      toNextRub: 0,
      progressPercent: 100,
    });
  });

  it('прогресс не вылезает за 0..100 при скачках через порог', () => {
    // 299 ₽ на второй ступени: путь 100→300 пройден почти весь
    const p = progressToNext(299, tiers);
    expect(p.progressPercent).toBe(99);
    expect(p.next?.name).toBe('Киноман');
  });
});

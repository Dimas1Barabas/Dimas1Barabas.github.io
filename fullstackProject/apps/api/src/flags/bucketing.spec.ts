import { bucketOf, evaluateFlag, FlagSnapshot } from './bucketing';

// Векторы сгенерированы Go-стороной (internal/domain) и вшиты в тесты
// ОБЕИХ реализаций: дрейк зеркала = красный тест, а не кривая раскатка.
const vectors: Array<[string, string, number]> = [
  ['checkout.new_flow', 'user-1', 99],
  ['checkout.new_flow', 'user-2', 10],
  ['checkout.new_flow', 'user-3', 21],
  ['demo.audience', 'user-1', 47],
  ['demo.audience', 'user-42', 6],
  ['booking.qr_v2', 'u-7@example.local', 58],
];

describe('bucketing (зеркало домена Go)', () => {
  it.each(vectors)('bucketOf("%s", "%s") = %i', (key, entity, expected) => {
    expect(bucketOf(key, entity)).toBe(expected);
  });

  it('бакет стабилен для пары (флаг, сущность)', () => {
    const first = bucketOf('some.flag', 'user-9');
    for (let i = 0; i < 50; i++) {
      expect(bucketOf('some.flag', 'user-9')).toBe(first);
    }
  });

  it('бакет всегда в диапазоне 0..99', () => {
    for (let i = 0; i < 1000; i++) {
      const b = bucketOf('dist.flag', `user-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});

describe('evaluateFlag', () => {
  const base: FlagSnapshot = {
    key: 'checkout.new_flow',
    description: '',
    enabled: true,
    percentage: 15,
    killed: false,
    updatedBy: 'qa',
    updatedAt: '2026-11-02T12:00:00Z',
  };

  it('kill-switch оффит всех поверх любых настроек', () => {
    const v = evaluateFlag({ ...base, percentage: 100, killed: true }, 'user-2');
    expect(v).toMatchObject({ enabled: false, reason: 'kill_switch' });
  });

  it('выключенный тумблер — оф независимо от процента', () => {
    const v = evaluateFlag({ ...base, enabled: false, percentage: 100 }, 'user-1');
    expect(v).toMatchObject({ enabled: false, reason: 'flag_off' });
  });

  it('100% — это on для хвостовых бакетов', () => {
    // user-1 — бакет 99: даже хвост внутри полной раскатки
    const v = evaluateFlag({ ...base, percentage: 100 }, 'user-1');
    expect(v).toMatchObject({ enabled: true, reason: 'on' });
  });

  it('частичная раскатка делит сущностей по бакету', () => {
    expect(evaluateFlag(base, 'user-2')).toMatchObject({
      enabled: true,
      reason: 'percentage',
    }); // бакет 10 < 15
    expect(evaluateFlag(base, 'user-3')).toMatchObject({
      enabled: false,
      reason: 'percentage',
    }); // бакет 21 ≥ 15
    expect(evaluateFlag(base, 'user-1')).toMatchObject({
      enabled: false,
      reason: 'percentage',
    }); // бакет 99 ≥ 15
  });

  it('граница раскатки включительна: 22% накрывает бакет 21', () => {
    expect(evaluateFlag({ ...base, percentage: 22 }, 'user-3').enabled).toBe(true);
  });

  it('отсутствующий флаг — оф с not_found (новая фича скрыта)', () => {
    expect(evaluateFlag(undefined, 'user-1')).toEqual({
      enabled: false,
      reason: 'not_found',
      percentage: 0,
      variant: '',
    });
  });
});

describe('evaluateFlag: A/B-эксперименты (зеркало домена Go)', () => {
  // те же векторы: user-1 → бакет 99, user-2 → 10, user-3 → 21
  const exp: FlagSnapshot = {
    key: 'checkout.new_flow',
    description: '',
    enabled: true,
    percentage: 0, // в эксперименте процент не участвует
    killed: false,
    variants: [
      { name: 'a', percentage: 15 }, // [0..15)
      { name: 'b', percentage: 20 }, // [15..35)
    ],
    updatedBy: 'qa',
    updatedAt: '2026-11-09T12:00:00Z',
  };

  it('кумулятивные доли: бакет 10 — вариант a, бакет 21 — вариант b', () => {
    expect(evaluateFlag(exp, 'user-2')).toEqual({
      enabled: true,
      reason: 'variant',
      percentage: 0,
      variant: 'a',
    });
    expect(evaluateFlag(exp, 'user-3')).toMatchObject({
      enabled: true,
      reason: 'variant',
      variant: 'b',
    });
  });

  it('остаток трафика — база: фича скрыта, вариант пустой', () => {
    expect(evaluateFlag(exp, 'user-1')).toEqual({
      enabled: false,
      reason: 'base',
      percentage: 0,
      variant: '',
    });
  });

  it('kill-switch и пауза гасят эксперимент без варианта', () => {
    expect(evaluateFlag({ ...exp, killed: true }, 'user-2')).toMatchObject({
      enabled: false,
      reason: 'kill_switch',
      variant: '',
    });
    expect(evaluateFlag({ ...exp, enabled: false }, 'user-2')).toMatchObject({
      enabled: false,
      reason: 'flag_off',
      variant: '',
    });
  });

  it('нулевая доля не получает трафика; сумма 100 — базы нет', () => {
    const zero = {
      ...exp,
      variants: [
        { name: 'a', percentage: 0 },
        { name: 'b', percentage: 50 },
      ],
    };
    expect(evaluateFlag(zero, 'user-2').variant).toBe('b');
    const full = {
      ...exp,
      variants: [
        { name: 'a', percentage: 50 },
        { name: 'b', percentage: 50 },
      ],
    };
    for (const entity of ['user-1', 'user-2', 'user-3']) {
      const v = evaluateFlag(full, entity);
      expect(v.enabled).toBe(true);
      expect(v.variant).not.toBe('');
    }
  });

  it('распределение стабильно: сущность не перелетает между вариантами', () => {
    const first = evaluateFlag(exp, 'user-2');
    for (let i = 0; i < 100; i++) {
      expect(evaluateFlag(exp, 'user-2')).toEqual(first);
    }
  });

  it('пустой variants — обычный флаг-тумблер (процент решает)', () => {
    const plain: FlagSnapshot = { ...exp, variants: [] };
    expect(evaluateFlag(plain, 'user-2')).toMatchObject({
      enabled: false,
      reason: 'percentage',
    });
  });
});

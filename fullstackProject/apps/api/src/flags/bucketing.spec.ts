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
    });
  });
});

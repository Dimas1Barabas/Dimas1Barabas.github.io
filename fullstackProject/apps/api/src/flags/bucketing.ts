/**
 * Зеркало домена flags-service (internal/domain): тот же детерминированный
 * бакетинг FNV-1a 64 по "key|entity" и те же правила вердикта. API кэширует
 * СНЯТКИ флагов и считает вердикты локально — kill-switch вступает в силу
 * за TTL кэша, без похода в сервис за каждым вердиктом.
 *
 * Векторы ниже зафиксированы тестами с обеих сторон (bucketing.spec.ts
 * и internal/domain/bucketing_test.go): дрейф любой из реализаций ломает
 * тест, а не раскатку.
 */

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;

/** Снимок флага — состояние тумблера на момент выборки. */
export interface FlagSnapshot {
  key: string;
  description: string;
  enabled: boolean;
  percentage: number;
  killed: boolean;
  updatedBy: string;
  updatedAt: string;
}

/** Какое правило вынесло вердикт — значения совпадают с доменом Go. */
export type FlagReason =
  | 'on'
  | 'percentage'
  | 'flag_off'
  | 'kill_switch'
  | 'not_found';

export interface FlagVerdict {
  enabled: boolean;
  reason: FlagReason;
  percentage: number;
}

/** Бакет сущности в раскатке флага: 0..99, стабилен для пары (флаг, сущность). */
export function bucketOf(key: string, entityId: string): number {
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(`${key}|${entityId}`, 'utf8')) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return Number(h % 100n);
}

/**
 * Вердикт флага для сущности. Приоритет правил (первый совпавший решает):
 * kill-switch → мастер-тумблер → бакет раскатки; 100% — это «on».
 * Отсутствующий флаг — оф с not_found: новая фича по умолчанию скрыта.
 */
export function evaluateFlag(
  flag: FlagSnapshot | undefined,
  entityId: string,
): FlagVerdict {
  if (!flag) return { enabled: false, reason: 'not_found', percentage: 0 };
  if (flag.killed) {
    return { enabled: false, reason: 'kill_switch', percentage: flag.percentage };
  }
  if (!flag.enabled) {
    return { enabled: false, reason: 'flag_off', percentage: flag.percentage };
  }
  if (flag.percentage >= 100) {
    return { enabled: true, reason: 'on', percentage: 100 };
  }
  return {
    enabled: bucketOf(flag.key, entityId) < flag.percentage,
    reason: 'percentage',
    percentage: flag.percentage,
  };
}

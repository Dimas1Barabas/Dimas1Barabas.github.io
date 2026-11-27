/**
 * Окна жизни группы «Идём вместе».
 *
 * Оба читаются из process.env без ConfigService — как PAYMENT_TIMEOUT_MS:
 * стенд CI-e2e ускоряет их своими значениями в compose, прод живёт
 * на дефолтах кода.
 */

/** Пicking: без активности (join/select/ready) группа распадается через это окно */
export const DEFAULT_GROUP_IDLE_TIMEOUT_MS = 15 * 60_000;

/** Fixed: после фиксации столько времени на брони своих мест */
export const DEFAULT_GROUP_FIXED_TIMEOUT_MS = 10 * 60_000;

function envMs(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function groupIdleTimeoutMs(): number {
  return envMs('GROUP_IDLE_TIMEOUT_MS', DEFAULT_GROUP_IDLE_TIMEOUT_MS);
}

export function groupFixedTimeoutMs(): number {
  return envMs('GROUP_FIXED_TIMEOUT_MS', DEFAULT_GROUP_FIXED_TIMEOUT_MS);
}

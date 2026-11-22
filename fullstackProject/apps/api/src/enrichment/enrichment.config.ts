/**
 * Конфиг внешнего кино-справочника (этап 37). В стенде живёт мок-контейнер
 * `kinoapi` (mocks/kinoapi), но контракт провайдер-нейтрален: любой HTTP-API
 * с ручкой /v1/movies/search?title=…
 *
 * EXTERNAL_MOVIES_URL — гейт всего модуля, как S3_ENDPOINT у постеров и
 * MEILI_HOST у поиска: переменной нет — клиент не строится, синк отвечает
 * 503, каталог живёт без внешних полей. Стенды без справочника (юнит-прогоны,
 * демо-Pages) не замечают этапа.
 *
 * Числа вынесены в env не для тюнинга на проде, а для тестов: спеки
 * breaker'а прогоняют кулдаун 30 c без ожидания — маленькими значениями.
 */
export interface EnrichmentConfig {
  /** http://kinoapi:8100 — scheme://host:port справочника */
  baseUrl: string;
  /** таймаут одного HTTP-попытки (поиск и постер) */
  timeoutMs: number;
  /** повторы ПОСЛЕ первой попытки: 5xx/429/сеть, с backoff */
  retries: number;
  /** breaker: сколько ПОДРЯД неудачных поисков открывают цепь */
  breakerThreshold: number;
  /** breaker: сколько секунд открытая цепь отбивает вызовы до полупробы */
  breakerCooldownMs: number;
  /** потолок скачиваемого постера — как у ручной загрузки (2 МБ) */
  posterMaxBytes: number;
}

const num = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function enrichmentConfigFromEnv(): EnrichmentConfig | null {
  const baseUrl = process.env.EXTERNAL_MOVIES_URL?.trim();
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    timeoutMs: num(process.env.EXTERNAL_MOVIES_TIMEOUT_MS, 3000),
    retries: num(process.env.EXTERNAL_MOVIES_RETRIES, 2),
    breakerThreshold: num(process.env.EXTERNAL_MOVIES_BREAKER_THRESHOLD, 5),
    breakerCooldownMs: num(process.env.EXTERNAL_MOVIES_BREAKER_COOLDOWN_MS, 30_000),
    posterMaxBytes: num(process.env.EXTERNAL_MOVIES_POSTER_MAX_BYTES, 2 * 1024 * 1024),
  };
}

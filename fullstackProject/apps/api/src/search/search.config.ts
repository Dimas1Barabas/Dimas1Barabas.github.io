/**
 * Конфиг поискового движка (этап 30). В стенде живёт Meilisearch из
 * docker compose (порт 7700, наружу 17700), клиент — официальный SDK
 * (npm meilisearch), протокол — REST: движок за переменной окружения.
 *
 * MEILI_HOST — гейт всего модуля: переменной нет — стор не строится,
 * поиск уходит на ILIKE-фолбэк в Postgres. Так стенды без движка
 * (юнит-прогоны, демо-Pages) не падают — тот же принцип, что у
 * S3_ENDPOINT у постеров.
 */
export interface SearchConfig {
  /** http://meilisearch:7700 — scheme://host[:port] движка */
  host: string;
  /** мастер-ключ (production-режим Meilisearch); пусто — dev-режим */
  apiKey: string;
}

export function searchConfigFromEnv(): SearchConfig | null {
  const host = process.env.MEILI_HOST?.trim();
  if (!host) return null;
  return {
    host,
    apiKey: process.env.MEILI_API_KEY ?? '',
  };
}

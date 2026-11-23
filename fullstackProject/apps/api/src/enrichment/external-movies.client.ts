import { Logger } from '@nestjs/common';
import { EnrichmentConfig } from './enrichment.config';

/**
 * Клиент внешнего кино-справочника (этап 37) — первая ВНЕШНЯЯ зависимость
 * проекта: до него все соседи API были своими (PG/Redis/Rabbit/Go-сервисы).
 * Отсюда и требования:
 *
 * - таймаут каждой попытки (AbortController) — витрина не ждёт висящий API;
 * - повторы с backoff на 5xx/429/сетевые ошибки; другие 4xx не повторяем —
 *   провайдер жив и ответил, это наша ошибка запроса;
 * - circuit breaker: N неудачных ПОИСКОВ подряд открывают цепь, следующие
 *   вызовы отпихиваются без похода в сеть, через кулдаун — полупроба.
 *   Скачивание постера цепь не трогает: постер — опция, его неудача
 *   означает «витрина на градиенте», а не «справочник лежит»;
 * - ответы парсим защищённо: чужой API может вернуть что угодно.
 */

/** запись справочника — провалидированная и приведённая к нашим типам */
export interface ExternalMovieRecord {
  title: string;
  year: number;
  /** рейтинг провайдера, шкала 0..10 (наша витрина показывает своё «по 5») */
  rating: number;
  votes: number;
  genres: string[];
  country: string;
  director: string;
  actors: string[];
  ageRating: string;
  trailerUrl: string;
  posterUrl: string;
}

/** постер справочника: байты + честный Content-Type */
export interface ExternalPoster {
  buffer: Buffer;
  contentType: string;
}

/** поверхность fetch, нужная клиенту — фейки в спеках её повторяют */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<ResponseLike>;

export interface ResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** «справочник недоступен» — синк отдаёт 502, каталог молча без external */
export class ExternalMoviesUnavailableError extends Error {
  constructor(readonly cause: string) {
    super(`внешний справочник недоступен: ${cause}`);
    this.name = 'ExternalMoviesUnavailableError';
  }
}

/** провайдер ответил, но не тем статусом, который мы умеем — не ретраить */
class PermanentHttpError extends Error {}

/**
 * Сетевая ошибка одним сообщением: undici заворачивает причину в
 * err.cause («fetch failed» без кода — ECONNREFUSED от ENOTFOUND не
 * отличить, run 411: синк на compose-стенде отдавал 502 «fetch failed»
 * без зацепки). Разворачиваем cause: код (ECONNREFUSED, ENOTFOUND…)
 * или сообщение.
 */
export function describeNetworkError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  if (cause === undefined || cause === null) return base;
  if (typeof cause === 'string') return `${base} (${cause})`;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return `${base} (${code ?? cause.message})`;
  }
  return base;
}

/** ретраебельные статусы: спросили слишком часто или у провайдера пятисотые */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** постер справочника проходит тот же белый список, что и ручная загрузка */
const POSTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Автомат защиты: closed → всё идёт; N неудач подряд → open (вызовы
 * отбиваются мгновенно, сеть не трогаем); через кулдаун → half-open,
 * пропускает ОДНУ пробу — успех закрывает цепь, провал открывает
 * заново на полный кулдаун.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get state(): BreakerState {
    if (this.failures < this.threshold) return 'closed';
    return this.now() - this.openedAt >= this.cooldownMs
      ? 'half-open'
      : 'open';
  }

  /** пустит ли цепь очередной вызов (half-open пускает пробу) */
  allows(): boolean {
    return this.state !== 'open';
  }

  /** число учтённых неудач — для витрины статуса и спек */
  get failureCount(): number {
    return this.failures;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      // провал полупробы: снова open на полный кулдаун с этого момента
      this.openedAt = this.now();
      return;
    }
    this.failures += 1;
    // момент ПЕРЕСЕЧЕНИЯ порога: от него тикает кулдаун. Дальше счётчик
    // растёт, но openedAt не двигаем — иначе периодические сбои держали
    // бы цепь открытой вечно
    if (this.failures === this.threshold) this.openedAt = this.now();
  }
}

/** нормализация названия для сверки: регистр, двойные пробелы, ё→е */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** лучший ответ справочника: точное совпадение > префикс > вложенность */
function pickBestMatch(
  query: string,
  items: ExternalMovieRecord[],
): ExternalMovieRecord | null {
  const q = normalizeTitle(query);
  if (!q) return null;
  let best: { score: number; item: ExternalMovieRecord } | null = null;
  for (const item of items) {
    const t = normalizeTitle(item.title);
    let score = 0;
    if (t === q) score = 4;
    else if (t.startsWith(q) || q.startsWith(t)) score = 3;
    else if (t.includes(q) || q.includes(t)) score = 2;
    if (score > (best?.score ?? 0)) best = { score, item };
  }
  return best ? best.item : null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** сырой item → запись: без строки title не проходит, остальное — дефолты */
function parseRecord(raw: unknown): ExternalMovieRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const title = asString(r.title);
  if (!title) return null;
  return {
    title,
    year: Math.trunc(asNumber(r.year)),
    rating: asNumber(r.rating),
    votes: Math.trunc(asNumber(r.votes)),
    genres: asStringArray(r.genres),
    country: asString(r.country),
    director: asString(r.director),
    actors: asStringArray(r.actors),
    ageRating: asString(r.ageRating),
    trailerUrl: asString(r.trailerUrl),
    posterUrl: asString(r.posterUrl),
  };
}

export interface ExternalMoviesClientDeps {
  /** подменяется в спеках; прод — глобальный fetch */
  fetchImpl?: FetchLike;
  /** пауза между ретраями — спеки подменяют на мгновенную */
  sleep?: (ms: number) => Promise<void>;
  /** часы breaker'а — спеки двигают кулдаун без реального ожидания */
  now?: () => number;
}

export class ExternalMoviesClient {
  private readonly logger = new Logger(ExternalMoviesClient.name);
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly breaker: CircuitBreaker;

  constructor(
    private readonly config: EnrichmentConfig,
    deps: ExternalMoviesClientDeps = {},
  ) {
    this.fetchImpl =
      deps.fetchImpl ?? ((url, init) => fetch(url, init) as Promise<ResponseLike>);
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.breaker = new CircuitBreaker(
      config.breakerThreshold,
      config.breakerCooldownMs,
      deps.now,
    );
  }

  /** состояние цепи — для админ-витрины и e2e */
  get breakerState(): BreakerState {
    return this.breaker.state;
  }

  /**
   * Прогрев при старте API: первый поход к новому origin (DNS + connect
   * + пул соединений) на CI-стендах иногда не укладывается в таймаут —
   * run 412: три попытки первого синка по «таймаут 3000 мс», при этом
   * запросы тем же маршрутом приходили секундами позже, а wget из
   * api-контейнера проходил мгновенно. Прогоняем пустой поиск вхолостую:
   * холодный старт достаётся прогреву, первый настоящий синк идёт по
   * тёплому коннекту. Fire-and-forget — бут не ждёт; ошибки гасятся
   * (недоступный на старте справочник — не событие), честный след
   * остаётся в warn-строках попыток и счётчике цепи.
   */
  warmup(): void {
    void this.findByTitle('warmup').catch(() => undefined);
  }

  /**
   * Поиск фильма по названию. null — справочник не знает фильма
   * (штатный исход синка). Throw ExternalMoviesUnavailableError —
   * ретраи исчерпаны или цепь открыта.
   */
  async findByTitle(title: string): Promise<ExternalMovieRecord | null> {
    if (!this.breaker.allows()) {
      throw new ExternalMoviesUnavailableError(
        `breaker открыт (${this.breaker.failureCount} неудач подряд)`,
      );
    }
    let lastCause = 'неизвестная ошибка';
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      if (attempt > 0) await this.sleep(this.backoffMs(attempt));
      try {
        const items = await this.searchOnce(title);
        this.breaker.recordSuccess();
        return pickBestMatch(title, items);
      } catch (err) {
        if (err instanceof PermanentHttpError) {
          // провайдер жив и ответил отказом — ретраи и цепь не помогут
          throw new ExternalMoviesUnavailableError(err.message);
        }
        lastCause = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `поиск «${title}»: попытка ${attempt + 1} не удалась — ${lastCause}`,
        );
      }
    }
    this.breaker.recordFailure();
    throw new ExternalMoviesUnavailableError(lastCause);
  }

  /**
   * Постер справочника: байты + Content-Type. null — любое несовершенство
   * (не-2xx, чужой Content-Type, пусто/велико, сеть): постер — опция
   * поверх градиентного фолбэка, его неудача не роняет синк.
   */
  async fetchPoster(url: string): Promise<ExternalPoster | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    try {
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) return null;
      const type = (res.headers?.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!POSTER_TYPES.has(type)) return null;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > this.config.posterMaxBytes) {
        return null;
      }
      return { buffer, contentType: type };
    } catch (err) {
      this.logger.warn(`постер ${url} не скачался: ${String(err)}`);
      return null;
    }
  }

  /** одна попытка поиска: таймаут → статус → защитный разбор JSON */
  private async searchOnce(title: string): Promise<ExternalMovieRecord[]> {
    const url =
      `${this.config.baseUrl}/v1/movies/search?title=${encodeURIComponent(title)}`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) {
      if (RETRYABLE_STATUS.has(res.status)) {
        throw new Error(`HTTP ${res.status}`);
      }
      throw new PermanentHttpError(`HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error('ответ не разобрать как JSON');
    }
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new Error('ответ без items[]');
    return items
      .map(parseRecord)
      .filter((x): x is ExternalMovieRecord => x !== null);
  }

  /** fetch с таймаутом: сетевые отказы и AbortError — ретраебельны */
  private async fetchWithTimeout(url: string): Promise<ResponseLike> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`таймаут ${this.config.timeoutMs} мс`);
      }
      throw new Error(describeNetworkError(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 200 → 400 → 800 мс… потолок 2 c (реальные паузы — только в проде) */
  private backoffMs(attempt: number): number {
    return Math.min(200 * 2 ** (attempt - 1), 2000);
  }
}

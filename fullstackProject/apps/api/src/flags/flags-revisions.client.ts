import { Injectable, Logger } from '@nestjs/common';

/** Строка аудита правок — форма HTTP-витрины /flags/revisions сервиса */
export interface FlagRevision {
  key: string;
  changedBy: string;
  changedAt: string;
  snapshot: { enabled: boolean; percentage: number; killed: boolean };
}

/**
 * HTTP-клиент витрины «Суфлёра»: аудит правок живёт в самом сервисе
 * (gRPC-контракт сознательно не таскает историю — она читальна, а не
 * транзакционна), паттерн витрины «Аналитика» (ANALYTICS_URL). Сбой —
 * пустая история в админке, это не критичный путь.
 */
@Injectable()
export class FlagsRevisionsClient {
  private readonly logger = new Logger('FlagsRevisionsClient');

  /** Аудит правок флага, свежими сверху; limit режет хвост */
  async revisions(key: string, limit = 20): Promise<FlagRevision[]> {
    try {
      const url = `${base()}/flags/revisions?key=${encodeURIComponent(key)}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { revisions?: FlagRevision[] };
      return body.revisions ?? [];
    } catch (err) {
      this.logger.warn(`витрина аудита недоступна (${key}): ${String(err)}`);
      return [];
    }
  }
}

/** Витрина «Суфлёра»: dev — хост-порт стенда, compose — сеть */
function base(): string {
  return process.env.FLAGS_HTTP_URL ?? 'http://localhost:18096';
}

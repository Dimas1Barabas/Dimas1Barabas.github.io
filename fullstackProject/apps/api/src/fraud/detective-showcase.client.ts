import { Injectable, Logger } from '@nestjs/common';

/** Строка витрины решений — форма HTTP-витрины /decisions детектива */
export interface FraudDecisionDto {
  bookingId: string;
  userId: string;
  sessionId: string;
  facts: {
    seatsCount: number;
    totalRub: number;
    accountAgeDays: number;
    bookings24h: number;
    cancels24h: number;
    failed24h: number;
  };
  score: number;
  verdict: FraudVerdictDto;
  reasons: string[];
  status: FraudDecisionStatusDto;
  resolvedBy: string;
  resolvedAt?: string;
  createdAt: string;
}

export type FraudVerdictDto = 'allow' | 'review' | 'block';

/** жизненный цикл решения: авто-вердикты закрыты сразу, review ждёт человека */
export type FraudDecisionStatusDto =
  | 'auto_allowed'
  | 'auto_blocked'
  | 'pending_review'
  | 'approved'
  | 'rejected';

/**
 * HTTP-клиент витрины «Детектива»: решения живут в самом сервисе
 * (gRPC-контракт сознательно не таскает историю — она читальна, а не
 * транзакционна), паттерн витрины «Суфлёра» (FLAGS_HTTP_URL) и
 * «Аналитика». Сбой — пустая очередь в админке, это не критичный путь.
 */
@Injectable()
export class DetectiveShowcaseClient {
  private readonly logger = new Logger('DetectiveShowcaseClient');

  /** Решения, свежими сверху; статус-фильтр — рабочая очередь ревью */
  async decisions(
    status?: string,
    limit = 50,
  ): Promise<FraudDecisionDto[]> {
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (status) params.set('status', status);
      const res = await fetch(`${base()}/decisions?${params}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { decisions?: FraudDecisionDto[] };
      return body.decisions ?? [];
    } catch (err) {
      this.logger.warn(`витрина решений недоступна: ${String(err)}`);
      return [];
    }
  }
}

/** Витрина «Детектива»: dev — хост-порт стенда, compose — сеть */
function base(): string {
  return process.env.DETECTIVE_HTTP_URL ?? 'http://localhost:18099';
}

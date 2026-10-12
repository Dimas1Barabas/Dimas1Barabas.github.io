import { Injectable, Logger } from '@nestjs/common';

/**
 * HTTP-клиент витрины «Поведение» Go-сервиса «Аналитик» (/insights).
 * Аналитик — асинхронный агрегатор: API ничего не знает о его агрегатах,
 * только проксирует ответ админ-странице. Недоступность — штатное дело
 * (сервис опционален для стенда): вызывающий получает null и отвечает
 * { available: false }, страница рисует честную заглушку.
 */
@Injectable()
export class AnalyticsInsightsClient {
  private readonly logger = new Logger('AnalyticsInsightsClient');
  private readonly base = process.env.ANALYTICS_URL ?? 'http://localhost:18092';

  /** витрина целиком; сервис недоступен/ответил мусором — null */
  async insights(): Promise<unknown | null> {
    try {
      const res = await fetch(`${this.base}/insights`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        this.logger.warn(`Аналитик ответил ${res.status}`);
        return null;
      }
      return (await res.json()) as unknown;
    } catch (err) {
      this.logger.warn(`Аналитик недоступен (${this.base}): ${String(err)}`);
      return null;
    }
  }
}

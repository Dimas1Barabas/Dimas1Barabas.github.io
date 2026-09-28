import { Injectable } from '@nestjs/common';
import { Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Реестр метрик Prometheus API. Собственный Registry вместо глобального
 * синглтона prom-client: юнит-тесты получают чистые счётчики без
 * «утечки» между спеками, а приложение — один предсказуемый источник
 * для /api/metrics.
 *
 * Имена метрик начинаются с cine_api_, лейблы — только низкокардинальные
 * (метод, шаблон маршрута, статус): сырой URL с id броней раздул бы
 * временные ряды на каждую бронь.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  /** длительность обработки HTTP-запросов; _count ряда заодно служит
   *  счётчиком запросов по method/route/status */
  readonly httpDuration: Histogram<string>;

  /** сколько запросов прямо сейчас внутри API (in-flight) */
  readonly httpInFlight: Gauge<string>;

  constructor() {
    // стандартные process_*/nodejs_* метрики — без префикса, чтобы
    // готовые дашборды Grafana их узнавали
    collectDefaultMetrics({ register: this.registry });

    this.httpDuration = new Histogram({
      name: 'cine_api_http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpInFlight = new Gauge({
      name: 'cine_api_http_requests_in_flight',
      help: 'Number of HTTP requests currently being served',
      registers: [this.registry],
    });
  }

  /** выгрузка в текстовом формате exposition format v0.0.4 */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }
}

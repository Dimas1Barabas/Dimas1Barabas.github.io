import { MetricsService } from './metrics.service';

/**
 * Юнит-тесты реестра метрик: собственный Registry у каждого инстанса
 * (спеки не наступают друг на друга) и выгрузка содержит оба ряда.
 */

describe('MetricsService', () => {
  it('регистрирует гистограмму и in-flight gauge в собственном реестре', async () => {
    const a = new MetricsService();
    const b = new MetricsService();

    expect(a.registry).not.toBe(b.registry);

    a.httpDuration.labels('GET', '/api/movies', '200').observe(0.05);
    a.httpInFlight.inc();

    const text = await a.metrics();
    expect(text).toContain(
      'cine_api_http_request_duration_seconds_count{method="GET",route="/api/movies",status="200"} 1',
    );
    expect(text).toContain('cine_api_http_requests_in_flight 1');

    // соседний инстанс ничего не знает про наблюдения первого
    const other = await b.metrics();
    expect(other).not.toContain('route="/api/movies"');
  });

  it('выгружает стандартные process/nodejs-метрики без префикса', async () => {
    const service = new MetricsService();
    const text = await service.metrics();

    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });
});

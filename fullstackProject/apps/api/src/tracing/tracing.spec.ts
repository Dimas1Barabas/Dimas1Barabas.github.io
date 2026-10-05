import { initTracing, otlpTraceUrl } from './tracing';

/**
 * Юнит-тесты каркаса трейсинга: гейт по OTEL_EXPORTER_OTLP_ENDPOINT
 * (без коллектора SDK не поднимается — CI-e2e без Jaeger не платит оверхед)
 * и формула URL выгрузки. Старт самого SDK в jest не проверяем —
 * автоинструментация патчит загруженные модули, это территория живого стенда.
 */

describe('initTracing', () => {
  const saved = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = saved;
    }
  });

  it('без OTEL_EXPORTER_OTLP_ENDPOINT SDK не поднимается', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(initTracing()).toBeUndefined();
  });
});

describe('otlpTraceUrl', () => {
  it('строит URL выгрузки из базового эндпоинта', () => {
    expect(otlpTraceUrl('http://jaeger:4318')).toBe(
      'http://jaeger:4318/v1/traces',
    );
  });

  it('терпит хвостовой слеш в эндпоинте', () => {
    expect(otlpTraceUrl('http://jaeger:4318///')).toBe(
      'http://jaeger:4318/v1/traces',
    );
  });
});

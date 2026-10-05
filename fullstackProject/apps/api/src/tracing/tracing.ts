import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Инициализация OpenTelemetry: HTTP/gRPC-клиент/ioredis/pg-спаны уходят
 * OTLP-экспортером в Jaeger (http/protobuf, 4318).
 *
 * SDK поднимается ТОЛЬКО при заданном OTEL_EXPORTER_OTLP_ENDPOINT: без
 * коллектора (юнит-тесты, CI-e2e без observability-сервисов) трейсинга нет
 * вовсе — нулевой оверхед вместо экспортера в никуда. Подключается сайд-эффект
 * импортом setup-tracing.ts ДО AppModule: инструментация патчит http/express
 * в момент загрузки модулей, после — уже поздно.
 */
export function initTracing(): NodeSDK | undefined {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;

  const sdk = new NodeSDK({
    serviceName: 'api',
    traceExporter: new OTLPTraceExporter({ url: otlpTraceUrl(endpoint) }),
    instrumentations: [
      // fs-инструментация плодит спан на каждый require/открытие файла
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  return sdk;
}

/** Базовый эндпоинт коллектора → URL выгрузки трейсов (протокол OTLP/HTTP) */
export function otlpTraceUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/traces`;
}

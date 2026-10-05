import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ConsumeMessage } from 'amqplib';
import { tracePublishOptions, withConsumeSpan } from './rabbit-trace';

/**
 * Пропагация через RabbitMQ герметично: настоящий NodeTracerProvider
 * с in-memory экспортером (без него глобальный tracer — no-op и заголовки
 * не пишутся). traceparent переживает публикацию, консьюмер продолжает
 * трейс публикатора и выполняет handler с активным спаном.
 */

let exporter: InMemorySpanExporter;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // register() ставит глобальный провайдер И W3C-пропагатор
  provider.register();
});

/** спан-родитель «публикатора» + его заголовки как в properties.headers */
async function publisherHeaders(
  name: string,
): Promise<{ headers: Record<string, string>; spanId: string; traceId: string }> {
  const span = trace.getTracer('spec').startSpan(name);
  const headers: Record<string, string> = {};
  await context.with(trace.setSpan(context.active(), span), async () => {
    propagation.inject(context.active(), headers);
  });
  const { spanId, traceId } = span.spanContext();
  span.end();
  return { headers, spanId, traceId };
}

describe('tracePublishOptions', () => {
  it('вне активного спана заголовков не пишет', () => {
    expect(tracePublishOptions().headers).toEqual({});
  });

  it('внутри спана кладёт traceparent с его trace id', async () => {
    const span = trace.getTracer('spec').startSpan('publish-root');
    let header = '';
    await context.with(trace.setSpan(context.active(), span), async () => {
      header = tracePublishOptions().headers.traceparent ?? '';
    });
    span.end();

    expect(header).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(header.split('-')[1]).toBe(span.spanContext().traceId);
  });
});

describe('withConsumeSpan', () => {
  it('продолжает трейс из заголовков и держит спан активным в handler', async () => {
    const parent = await publisherHeaders('publish-root');

    let activeTraceId = '';
    await withConsumeSpan(
      'api.booking.processed',
      'booking.processed',
      { properties: { headers: parent.headers } } as Pick<ConsumeMessage, 'properties'>,
      async () => {
        // спан консьюмера активен: вложенная публикация уедет с его контекстом
        activeTraceId = trace.getSpan(context.active())!.spanContext().traceId;
        expect(tracePublishOptions().headers.traceparent).toBeDefined();
      },
    );

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'rabbit.consume booking.processed');
    expect(span).toBeDefined();
    expect(span!.kind).toBe(SpanKind.CONSUMER);
    expect(span!.parentSpanContext?.spanId).toBe(parent.spanId);
    expect(activeTraceId).toBe(parent.traceId);
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(span!.attributes['messaging.destination.name']).toBe(
      'api.booking.processed',
    );
  });

  it('ошибка handler’а: спан ERROR с исключением, ошибка пробрасывается', async () => {
    await expect(
      withConsumeSpan('api.q', 'rk', undefined, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'rabbit.consume rk');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('сообщение без заголовков — корневой консьюмер-спан, не падает', async () => {
    await withConsumeSpan('api.q', 'rk.bare', undefined, async () => {
      expect(trace.getSpan(context.active())).toBeDefined();
    });

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'rabbit.consume rk.bare');
    expect(span).toBeDefined();
    expect(span!.parentSpanContext?.spanId).toBeUndefined();
  });
});

import { context, propagation, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ConsumeMessage } from 'amqplib';
import { BarOrderStatusEvent } from './bar-events';
import { BarConsumer } from './bar.consumer';
import { BarService } from './bar.service';

/**
 * Консьюмер статусов кинобара продолжает трейс Бармена: traceparent из
 * заголовках сообщения → CONSUMER-спан, handleStatus вызван в его
 * контексте. Идиома одна на все очереди API (доказана на вердиктах
 * воркера) — здесь второй рубеж для новой очереди.
 */
describe('BarConsumer (трейсинг)', () => {
  let exporter: InMemorySpanExporter;
  let handleStatus: jest.Mock;
  let consumer: BarConsumer;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }).register();
  });

  beforeEach(() => {
    exporter.reset();
    handleStatus = jest.fn().mockResolvedValue(undefined);
    consumer = new BarConsumer({ handleStatus } as unknown as BarService);
  });

  const event: BarOrderStatusEvent = {
    orderId: 'order-1',
    status: 'READY',
    email: 'anna@test.local',
    customerName: 'Анна',
    changedAt: new Date().toISOString(),
  };

  it('строит CONSUMER-спан ребёнком Бармена и зовёт handleStatus', async () => {
    const span = trace.getTracer('spec').startSpan('barman-ready');
    const headers: Record<string, string> = {};
    await context.with(trace.setSpan(context.active(), span), async () => {
      propagation.inject(context.active(), headers);
    });
    const { spanId } = span.spanContext();
    span.end();

    await consumer.onStatus(event, {
      properties: { headers },
    } as ConsumeMessage);

    expect(handleStatus).toHaveBeenCalledWith(event);
    const finished = exporter.getFinishedSpans();
    const consumerSpan = finished.find((s) => s.name === 'api.bar.status');
    expect(consumerSpan).toBeDefined();
    expect(consumerSpan!.parentSpanContext?.spanId).toBe(spanId);
  });

  it('без traceparent спан становится корнем — событие не теряется', async () => {
    await consumer.onStatus(event);

    expect(handleStatus).toHaveBeenCalledWith(event);
    const consumerSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'api.bar.status');
    expect(consumerSpan).toBeDefined();
  });
});

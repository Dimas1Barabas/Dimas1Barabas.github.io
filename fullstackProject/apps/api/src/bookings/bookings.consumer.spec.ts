import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ConsumeMessage } from 'amqplib';
import { BookingProcessedEvent } from './booking-events';
import { BookingsConsumer } from './bookings.consumer';
import { BookingsService } from './bookings.service';

/**
 * Консьюмер продолжает трейс публикатора: traceparent из заголовков
 * сообщения → CONSUMER-спан, доменный сервис вызван в его контексте.
 * Идиома одна на все очереди API — здесь доказана на вердиктах воркера.
 */

describe('BookingsConsumer (трейсинг)', () => {
  let exporter: InMemorySpanExporter;
  let handleProcessed: jest.Mock;
  let consumer: BookingsConsumer;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }).register();
  });

  beforeEach(() => {
    exporter.reset(); // спаны не копятся между тестами
    handleProcessed = jest.fn().mockResolvedValue(undefined);
    consumer = new BookingsConsumer({
      handleProcessed,
    } as unknown as BookingsService);
  });

  const verdict: BookingProcessedEvent = {
    bookingId: 'booking-1',
    status: 'CONFIRMED',
    message: 'платёж прошёл',
    processedBy: 'ticket-worker',
    processedAt: new Date().toISOString(),
  };

  /** заголовки, как их написал публикатор внутри своего спана */
  async function traceparentOf(name: string): Promise<{
    headers: Record<string, string>;
    spanId: string;
  }> {
    const span = trace.getTracer('spec').startSpan(name);
    const headers: Record<string, string> = {};
    await context.with(trace.setSpan(context.active(), span), async () => {
      propagation.inject(context.active(), headers);
    });
    const { spanId } = span.spanContext();
    span.end();
    return { headers, spanId };
  }

  it('строит CONSUMER-спан ребёнком публикатора и зовёт сервис', async () => {
    const parent = await traceparentOf('worker-verdict');

    await consumer.onProcessed(verdict, {
      properties: { headers: parent.headers },
    } as ConsumeMessage);

    expect(handleProcessed).toHaveBeenCalledTimes(1);
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'rabbit.consume booking.processed');
    expect(span).toBeDefined();
    expect(span!.parentSpanContext?.spanId).toBe(parent.spanId);
  });

  it('ошибка домена фиксируется в спане и летит в errorHandler', async () => {
    handleProcessed.mockRejectedValueOnce(new Error('db down'));

    await expect(
      consumer.onProcessed(verdict, undefined),
    ).rejects.toThrow('db down');

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'rabbit.consume booking.processed');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
  });
});

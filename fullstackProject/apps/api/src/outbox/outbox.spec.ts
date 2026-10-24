import { context, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { EntityManager } from 'typeorm';
import { OutboxMessage } from './outbox-message.entity';
import { enqueueOutbox } from './outbox';

/**
 * enqueueOutbox герметично: мок EntityManager'а проверяет запись в outbox
 * репозиторием ПЕРЕДАННОГО em (значит — внутри бизнес-транзакции), а
 * настоящий NodeTracerProvider с in-memory экспортером (без него глобальный
 * tracer — no-op и traceparent не пишется) — захват traceparent на момент
 * записи, а не публикации.
 */

beforeAll(() => {
  new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
  }).register(); // register() ставит глобальный провайдер И W3C-пропагатор
});

function mockEm() {
  const insert = jest.fn().mockResolvedValue({ identifiers: [{}] });
  const em = {
    getRepository: jest.fn().mockReturnValue({ insert }),
  } as unknown as EntityManager;
  return { em, insert };
}

describe('enqueueOutbox', () => {
  it('пишет событие репозиторием переданного EntityManager', async () => {
    const { em, insert } = mockEm();

    await enqueueOutbox(em, 'booking.created', { bookingId: 'b-1' });

    expect(em.getRepository).toHaveBeenCalledWith(OutboxMessage);
    expect(insert).toHaveBeenCalledWith({
      routingKey: 'booking.created',
      payload: { bookingId: 'b-1' },
      headers: {},
    });
  });

  it('кладёт traceparent активного спана в headers на момент записи', async () => {
    const { em, insert } = mockEm();
    const span = trace.getTracer('spec').startSpan('bookings.create');

    await context.with(trace.setSpan(context.active(), span), async () => {
      await enqueueOutbox(em, 'booking.payment.wait', { bookingId: 'b-1' });
    });
    span.end();

    const headers = insert.mock.calls[0][0].headers as Record<string, string>;
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers.traceparent!.split('-')[1]).toBe(
      span.spanContext().traceId,
    );
  });
});

import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { ConsumeMessage } from 'amqplib';

const tracer = trace.getTracer('cine-booking/rabbit');

/**
 * Шов трейсинга на RabbitMQ (W3C traceparent в заголовках сообщения):
 * публикация инжектит контекст активного спана, консьюмер продолжает трейс
 * публикатора. Без SDK глобальный tracer — no-op: заголовки не пишутся,
 * поведение публикаторов/консьюмеров не меняется.
 */

/** Публикация: traceparent активного спана едет в заголовках сообщения */
export function tracePublishOptions(): { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  propagation.inject(context.active(), headers);
  return { headers };
}

/**
 * Консьюмер: извлекает родителя из заголовков сообщения, создаёт
 * CONSUMER-спан и выполняет handler с ним активным — вложенные publish/gRPC
 * цепляются в ту же трассу. Ошибка фиксируется в спане и пробрасывается
 * дальше (errorHandler → retry → parking работают как раньше).
 */
export async function withConsumeSpan<T>(
  queue: string,
  routingKey: string,
  message: Pick<ConsumeMessage, 'properties'> | undefined,
  handler: () => T | Promise<T>,
): Promise<T> {
  const headers = (message?.properties?.headers ?? {}) as Record<
    string,
    unknown
  >;
  const parent = propagation.extract(context.active(), headers);
  const span = tracer.startSpan(
    `rabbit.consume ${routingKey}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': queue,
        'messaging.rabbitmq.routing_key': routingKey,
      },
    },
    parent,
  );
  try {
    const result = await context.with(trace.setSpan(parent, span), handler);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (err as Error).message,
    });
    throw err;
  } finally {
    span.end();
  }
}

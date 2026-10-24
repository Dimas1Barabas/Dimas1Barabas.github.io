import { EntityManager } from 'typeorm';
import { tracePublishOptions } from '../tracing/rabbit-trace';
import { OutboxMessage } from './outbox-message.entity';

/**
 * Запись события в транзакционный outbox — тем же EntityManager, что и
 * бизнес-данные: либо коммитятся обе записи, либо ни одна. Публикацией
 * владеет релей (services/outbox-relay, «Курьер»): он вынет сообщение
 * позже, опубликует с сохранёнными headers и поставит publishedAt.
 *
 * traceparent захватывается ЗДЕСЬ, на момент записи: отложенная публикация
 * остаётся в трейсе исходной операции (HTTP-запроса или консьюмера).
 * Без SDK заголовков нет — релей опубликует без traceparent, поведение
 * не меняется.
 */
export async function enqueueOutbox(
  em: EntityManager,
  routingKey: string,
  payload: object,
): Promise<void> {
  const { headers } = tracePublishOptions();
  await em
    .getRepository(OutboxMessage)
    .insert({ routingKey, payload, headers });
}

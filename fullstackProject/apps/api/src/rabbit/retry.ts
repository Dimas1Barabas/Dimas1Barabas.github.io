import type { MessageErrorHandler } from '@golevelup/nestjs-rabbitmq';
import { Logger, NotFoundException } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';

/** заголовок-счётчик попыток: инкрементим при каждом уходе в retry */
export const RETRY_HEADER = 'x-retry-count';

/** всего попыток обработки (1 оригинал + 2 ретрая), дальше — parking */
export const MAX_ATTEMPTS = 3;

/** сколько retry-очередь держит сообщение перед возвратом в рабочую */
export const RETRY_TTL_MS = 5_000;

/** сколько раз сообщение уже ретраилось (0 — оригинал) */
export function readAttempts(msg: ConsumeMessage): number {
  const value = msg.properties.headers?.[RETRY_HEADER];
  return typeof value === 'number' ? value : 0;
}

/**
 * ErrorHandler для @RabbitSubscribe: сообщение при сбое обработки не теряется.
 *
 * Транзиентная ошибка (например, БД недоступна) → публикация копии в
 * `<rk>.retry`: эта очередь держит сообщение RETRY_TTL_MS и по TTL сама
 * возвращает его в рабочую очередь — паузу между попытками делает брокер.
 * «Ядовитое» сообщение (NotFound — такой брони уже нет) ретраить бессмысленно,
 * оно уходит в parking сразу. После MAX_ATTEMPTS попыток в `<rk>.parking`
 * уходит всё — эти сообщения разбирают вручную (админ-очередь).
 */
export function retryErrorHandler(routingKey: string): MessageErrorHandler {
  const logger = new Logger(`RabbitRetry[${routingKey}]`);
  return (channel: Channel, msg: ConsumeMessage, error: unknown) => {
    const attempt = readAttempts(msg) + 1;
    const poison = error instanceof NotFoundException;
    const target = !poison && attempt < MAX_ATTEMPTS ? 'retry' : 'parking';
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`попытка ${attempt}: ${message} → ${target}`);

    channel.publish('cinema', `${routingKey}.${target}`, msg.content, {
      contentType: msg.properties.contentType,
      persistent: true,
      headers: {
        ...msg.properties.headers,
        [RETRY_HEADER]: attempt,
        'x-last-error': message,
      },
    });
    channel.ack(msg); // судьба исходного решена: оно уехало в retry/parking
  };
}

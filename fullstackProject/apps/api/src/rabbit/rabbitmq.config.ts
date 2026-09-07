import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import type { RabbitMQQueueConfig } from '@golevelup/nestjs-rabbitmq';
import { RETRY_TTL_MS } from './retry';

/**
 * Динамический модуль RabbitMQ создаётся один раз и переиспользуется:
 * AppModule регистрирует подключение, BookingsModule — инжектит AmqpConnection.
 * (Nest дедуплицирует модули по классу, соединение будет одно.)
 */
export const rabbitMqModule = RabbitMQModule.forRoot({
  uri: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672/',
  exchanges: [
    {
      name: 'cinema',
      type: 'topic',
      createExchangeIfNotExists: true,
      options: { durable: true },
    },
  ],
  // retry/parking-очереди для событий, которые консьюмит сам API.
  // Рабочие очереди (api.booking.*) объявляют @RabbitSubscribe-декораторы.
  queues: [
    ...withRetryTopology('api.booking.processed', 'booking.processed'),
    ...withRetryTopology('api.booking.refunded', 'booking.refunded'),
  ],
  connectionInitOptions: { wait: true, reject: true, timeout: 60_000 },
});

/**
 * Топология надёжности для рабочей очереди `queue` (бинд `cinema` ← routingKey):
 *
 *   `<queue>.retry`   — без потребителей, держит упавшее сообщение RETRY_TTL_MS
 *                       и по TTL (dead-letter) возвращает его в рабочую очередь;
 *   `<queue>.parking` — «парковка» отработавших попытки: poison или всё, что
 *                       не пережило MAX_ATTEMPTS, разбирают вручную.
 */
export function withRetryTopology(
  queue: string,
  routingKey: string,
): RabbitMQQueueConfig[] {
  return [
    {
      name: `${queue}.retry`,
      exchange: 'cinema',
      routingKey: `${routingKey}.retry`,
      createQueueIfNotExists: true,
      options: {
        durable: true,
        arguments: {
          'x-message-ttl': RETRY_TTL_MS,
          'x-dead-letter-exchange': 'cinema',
          // по истечении TTL брокер сам вернёт сообщение в рабочую очередь
          'x-dead-letter-routing-key': routingKey,
        },
      },
    },
    {
      name: `${queue}.parking`,
      exchange: 'cinema',
      routingKey: `${routingKey}.parking`,
      createQueueIfNotExists: true,
      options: { durable: true },
    },
  ];
}

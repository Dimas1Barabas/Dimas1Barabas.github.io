import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { retryErrorHandler } from '../rabbit/retry';
import { withConsumeSpan } from '../tracing/rabbit-trace';
import { BarOrderStatusEvent } from './bar-events';
import { BarService } from './bar.service';

/**
 * Слушает статусные переходы Бармена (кнопки «в работу» / «готово» /
 * «выдано» на экране бара) и отражает их в bar_orders — источник статуса
 * для «Моих заказов». Параллельно то же событие читает
 * notification-service («письмо» о готовности). Сбой обработки не роняет
 * событие: retry → parking.
 */
@Injectable()
export class BarConsumer {
  constructor(private readonly bar: BarService) {}

  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'bar.order.status',
    queue: 'api.bar.status',
    queueOptions: { durable: true },
    errorHandler: retryErrorHandler('bar.order.status'),
  })
  async onStatus(
    event: BarOrderStatusEvent,
    raw?: ConsumeMessage,
  ): Promise<void> {
    await withConsumeSpan(
      'api.bar.status',
      'bar.order.status',
      raw,
      () => this.bar.handleStatus(event),
    );
  }
}

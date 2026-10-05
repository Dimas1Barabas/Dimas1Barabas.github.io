import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { retryErrorHandler } from '../rabbit/retry';
import { withConsumeSpan } from '../tracing/rabbit-trace';
import { WaitlistSeatReleasedEvent } from './waitlist-events';
import { WaitlistService } from './waitlist.service';

/**
 * Слушает собственные события «места снова в продаже» (публикуют четыре
 * точки BookingsService) и уведомляет голову листа ожидания — честная
 * гонка без резерва. Сбой обработки не роняет событие: retry → parking.
 */
@Injectable()
export class WaitlistConsumer {
  constructor(private readonly waitlist: WaitlistService) {}

  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'waitlist.seat.released',
    queue: 'api.waitlist.released',
    queueOptions: { durable: true },
    errorHandler: retryErrorHandler('waitlist.seat.released'),
  })
  async onSeatReleased(
    event: WaitlistSeatReleasedEvent,
    raw?: ConsumeMessage,
  ): Promise<void> {
    await withConsumeSpan(
      'api.waitlist.released',
      'waitlist.seat.released',
      raw,
      () => this.waitlist.handleSeatReleased(event),
    );
  }
}

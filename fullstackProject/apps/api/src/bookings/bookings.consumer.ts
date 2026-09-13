import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { retryErrorHandler } from '../rabbit/retry';
import {
  BookingExpiredEvent,
  BookingProcessedEvent,
  BookingRefundedEvent,
} from './booking-events';
import { BookingsService } from './bookings.service';

/** Слушает результаты обработки от Go-воркера и обновляет брони в Postgres */
@Injectable()
export class BookingsConsumer {
  constructor(private readonly bookings: BookingsService) {}

  /** сбой обработки не роняет событие: retry → parking (см. rabbit/retry.ts) */
  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'booking.processed',
    queue: 'api.booking.processed',
    queueOptions: { durable: true },
    errorHandler: retryErrorHandler('booking.processed'),
  })
  async onProcessed(event: BookingProcessedEvent): Promise<void> {
    await this.bookings.handleProcessed(event);
  }

  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'booking.refunded',
    queue: 'api.booking.refunded',
    queueOptions: { durable: true },
    errorHandler: retryErrorHandler('booking.refunded'),
  })
  async onRefunded(event: BookingRefundedEvent): Promise<void> {
    await this.bookings.handleRefunded(event);
  }

  /** TTL wait-очереди резерва истёк: неоплаченная бронь гасится в EXPIRED */
  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'booking.expired',
    queue: 'api.booking.expired',
    queueOptions: { durable: true },
    errorHandler: retryErrorHandler('booking.expired'),
  })
  async onExpired(event: BookingExpiredEvent): Promise<void> {
    await this.bookings.handleExpired(event);
  }
}

import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import {
  BookingProcessedEvent,
  BookingRefundedEvent,
} from './booking-events';
import { BookingsService } from './bookings.service';

/** Слушает результаты обработки от Go-воркера и обновляет брони в Postgres */
@Injectable()
export class BookingsConsumer {
  constructor(private readonly bookings: BookingsService) {}

  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'booking.processed',
    queue: 'api.booking.processed',
    queueOptions: { durable: true },
  })
  async onProcessed(event: BookingProcessedEvent): Promise<void> {
    await this.bookings.handleProcessed(event);
  }

  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'booking.refunded',
    queue: 'api.booking.refunded',
    queueOptions: { durable: true },
  })
  async onRefunded(event: BookingRefundedEvent): Promise<void> {
    await this.bookings.handleRefunded(event);
  }
}

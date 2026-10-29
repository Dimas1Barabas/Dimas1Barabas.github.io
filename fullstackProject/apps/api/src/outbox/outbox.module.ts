import { Module } from '@nestjs/common';
import { OutboxRelayClient } from './outbox-relay.client';

/**
 * Один экземпляр будильника Курьера на всё приложение: Bookings/Auth/
 * Reviews/Waitlist модули импортируют этот — ленивое gRPC-соединение
 * общее. enqueueOutbox — чистая функция, ей модуль не нужен.
 */
@Module({
  providers: [OutboxRelayClient],
  exports: [OutboxRelayClient],
})
export class OutboxModule {}

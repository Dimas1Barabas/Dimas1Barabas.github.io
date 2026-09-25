import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { RemindersConsumer } from './reminders.consumer';

/**
 * Напоминания о сеансе: модуль держит только SSE-консьюмера события
 * «письмо ушло». gRPC-клиент живёт в BookingsModule (его зовут
 * вердиктные хуки) — так зависимость однонаправленна и цикла нет.
 */
@Module({
  imports: [BookingsModule, rabbitMqModule],
  providers: [RemindersConsumer],
})
export class RemindersModule {}

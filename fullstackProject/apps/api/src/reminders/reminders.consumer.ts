import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { BookingStream } from '../bookings/booking-stream';
import { retryErrorHandler } from '../rabbit/retry';
import { ReminderStreamPayload, UserSessionReminderEvent } from './reminder-events';

/**
 * Слушает «письмо ушло» от reminder-сервиса (момент «сеанс − окно»
 * настал) и показывает его зрителю живым SSE-событием `reminder` —
 * тот же эндпоинт /bookings/stream, клиент матчит payload.userId
 * по себе. Письмо notification-service собирает из того же события
 * параллельной очередью — связка только через брокер.
 */
@Injectable()
export class RemindersConsumer {
  constructor(private readonly stream: BookingStream) {}

  @RabbitSubscribe({
    exchange: 'cinema',
    routingKey: 'user.session.reminder',
    queue: 'api.reminder.sent',
    queueOptions: { durable: true },
    errorHandler: retryErrorHandler('user.session.reminder'),
  })
  async onReminderSent(event: UserSessionReminderEvent): Promise<void> {
    // email вырезаем: стрим публичен (EventSource без заголовков),
    // адресат — дело notification-service
    const payload: ReminderStreamPayload = {
      userId: event.userId,
      bookingId: event.bookingId,
      movieId: event.movieId,
      movieTitle: event.movieTitle,
      hall: event.hall,
      sessionAt: event.sessionAt,
      seats: event.seats,
      remindedAt: event.remindedAt,
    };
    this.stream.emitReminder(payload);
  }
}

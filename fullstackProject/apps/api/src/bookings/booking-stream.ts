import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import { ReminderStreamPayload } from '../reminders/reminder-events';
import { WaitlistStreamPayload } from '../waitlist/waitlist-events';
import { BookingDto, BookingStatus } from './booking.entity';

/** Что прилетает клиенту по SSE: изменённая бронь + свежая статистика */
export interface BookingStreamPayload {
  booking: BookingDto;
  stats: Record<BookingStatus, number>;
}

/**
 * Шина «изменения броней → подключённые SSE-клиенты».
 * Сервис эмитит после каждой мутации (create/cancel/processed/refunded),
 * контроллер мультикастит это в открытые EventSource-соединения.
 *
 * Отдельный канал waitlist$ — «место освободилось» голове листа
 * ожидания; reminder$ — «скоро сеанс» от reminder-сервиса: тот же
 * эндпоинт /bookings/stream, другой тип события.
 */
@Injectable()
export class BookingStream {
  private readonly subject = new Subject<BookingStreamPayload>();
  private readonly waitlistSubject = new Subject<WaitlistStreamPayload>();
  private readonly reminderSubject = new Subject<ReminderStreamPayload>();

  readonly events$ = this.subject.asObservable();
  readonly waitlist$ = this.waitlistSubject.asObservable();
  readonly reminder$ = this.reminderSubject.asObservable();

  emit(payload: BookingStreamPayload): void {
    this.subject.next(payload);
  }

  emitWaitlist(payload: WaitlistStreamPayload): void {
    this.waitlistSubject.next(payload);
  }

  emitReminder(payload: ReminderStreamPayload): void {
    this.reminderSubject.next(payload);
  }
}

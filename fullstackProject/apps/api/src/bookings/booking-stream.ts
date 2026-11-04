import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import { STREAM_BUS, StreamBus } from '../redis/stream-bus';
import { ReminderStreamPayload } from '../reminders/reminder-events';
import { WaitlistStreamPayload } from '../waitlist/waitlist-events';
import { BookingDto, BookingStatus } from './booking.entity';

/** Что прилетает клиенту по SSE: изменённая бронь + свежая статистика */
export interface BookingStreamPayload {
  booking: BookingDto;
  stats: Record<BookingStatus, number>;
}

/** kind'ы шины: по одному на канал ниже (демультиплексор в RedisStreamBus) */
const KIND_BOOKING = 'booking';
const KIND_WAITLIST = 'waitlist';
const KIND_REMINDER = 'reminder';

/**
 * Шина «изменения броней → подключённые SSE-клиенты».
 * Сервис эмитит после каждой мутации (create/cancel/processed/refunded),
 * контроллер мультикастит это в открытые EventSource-соединения.
 *
 * Отдельный канал waitlist$ — «место освободилось» голове листа
 * ожидания; reminder$ — «скоро сеанс» от reminder-сервиса: тот же
 * эндпоинт /bookings/stream, другой тип события.
 *
 * Кросс-подовая рассылка: emit дёргает локальных подписчиков
 * синхронно (как раньше) и публикует в Redis-шину — соседние поды
 * (реплики, канарейка) получают тот же кадр своими subject'ами.
 * Без соседей поведение не отличимо от одиночного пода.
 */
@Injectable()
export class BookingStream implements OnModuleInit {
  private readonly subject = new Subject<BookingStreamPayload>();
  private readonly waitlistSubject = new Subject<WaitlistStreamPayload>();
  private readonly reminderSubject = new Subject<ReminderStreamPayload>();

  readonly events$ = this.subject.asObservable();
  readonly waitlist$ = this.waitlistSubject.asObservable();
  readonly reminder$ = this.reminderSubject.asObservable();

  constructor(@Inject(STREAM_BUS) private readonly bus: StreamBus) {}

  onModuleInit(): void {
    this.bus.subscribe(KIND_BOOKING, (payload) =>
      this.subject.next(payload as BookingStreamPayload),
    );
    this.bus.subscribe(KIND_WAITLIST, (payload) =>
      this.waitlistSubject.next(payload as WaitlistStreamPayload),
    );
    this.bus.subscribe(KIND_REMINDER, (payload) =>
      this.reminderSubject.next(payload as ReminderStreamPayload),
    );
  }

  emit(payload: BookingStreamPayload): void {
    this.subject.next(payload);
    this.bus.publish(KIND_BOOKING, payload);
  }

  emitWaitlist(payload: WaitlistStreamPayload): void {
    this.waitlistSubject.next(payload);
    this.bus.publish(KIND_WAITLIST, payload);
  }

  emitReminder(payload: ReminderStreamPayload): void {
    this.reminderSubject.next(payload);
    this.bus.publish(KIND_REMINDER, payload);
  }
}

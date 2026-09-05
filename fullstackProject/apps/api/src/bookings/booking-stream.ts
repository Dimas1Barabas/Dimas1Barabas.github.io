import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
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
 */
@Injectable()
export class BookingStream {
  private readonly subject = new Subject<BookingStreamPayload>();

  readonly events$ = this.subject.asObservable();

  emit(payload: BookingStreamPayload): void {
    this.subject.next(payload);
  }
}

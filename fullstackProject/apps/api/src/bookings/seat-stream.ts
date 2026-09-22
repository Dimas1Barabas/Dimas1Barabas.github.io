import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/** Сигнал шине мест: по сеансу изменилась занятость (заняли/освободили) */
export interface SeatStreamPayload {
  sessionId: string;
}

/**
 * Шина «изменение занятости мест → WS-гейтвей живой карты».
 *
 * Отдельная шина, а не третий канал BookingStream: карта мест — другой
 * потребитель (WS-комнаты по сеансу, не витринное табло), и контракт
 * BookingStream (DTO брони + статистика) здесь не нужен. Пейлоад — только
 * sessionId: гейтвей сам перечитает карту из БД и раздаст полный снапшот,
 * единственный источник истины остаётся в seat_occupancy.
 */
@Injectable()
export class SeatStream {
  private readonly subject = new Subject<SeatStreamPayload>();

  readonly events$ = this.subject.asObservable();

  emit(payload: SeatStreamPayload): void {
    this.subject.next(payload);
  }
}

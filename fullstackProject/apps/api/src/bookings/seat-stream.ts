import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import { STREAM_BUS, StreamBus } from '../redis/stream-bus';

/** Сигнал шине мест: по сеансу изменилась занятость (заняли/освободили) */
export interface SeatStreamPayload {
  sessionId: string;
}

const KIND_SEAT = 'seat';

/**
 * Шина «изменение занятости мест → WS-гейтвей живой карты».
 *
 * Отдельная шина, а не третий канал BookingStream: карта мест — другой
 * потребитель (WS-комнаты по сеансу, не витринное табло), и контракт
 * BookingStream (DTO брони + статистика) здесь не нужен. Пейлоад — только
 * sessionId: гейтвей сам перечитает карту из БД и раздаст полный снапшот,
 * единственный источник истины остаётся в seat_occupancy.
 *
 * Кросс-подовая рассылка: emit синхронно будит локальный WS-гейтвей
 * (комнаты живут в памяти пода) и публикует sessionId в Redis-шину —
 * гейтвеи соседних подов перечитают карту и раздаст снапшоты своим
 * комнатам того же сеанса. Без соседей — как раньше.
 */
@Injectable()
export class SeatStream implements OnModuleInit {
  private readonly subject = new Subject<SeatStreamPayload>();

  readonly events$ = this.subject.asObservable();

  constructor(@Inject(STREAM_BUS) private readonly bus: StreamBus) {}

  onModuleInit(): void {
    this.bus.subscribe(KIND_SEAT, (payload) =>
      this.subject.next(payload as SeatStreamPayload),
    );
  }

  emit(payload: SeatStreamPayload): void {
    this.subject.next(payload);
    this.bus.publish(KIND_SEAT, payload);
  }
}

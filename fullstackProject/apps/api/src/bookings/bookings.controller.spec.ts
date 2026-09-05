import { MessageEvent } from '@nestjs/common';
import { firstValueFrom, take } from 'rxjs';
import { BookingStream } from './booking-stream';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import type { BookingDto, BookingStatus } from './booking.entity';

/** SSE-эндпоинт: шина событий + heartbeat в одном Observable */

const emptyStats: Record<BookingStatus, number> = {
  PENDING: 0,
  CONFIRMED: 0,
  FAILED: 0,
  CANCELLING: 0,
  CANCELLED: 0,
};

function makeController(): {
  controller: BookingsController;
  stream: BookingStream;
} {
  const stream = new BookingStream();
  const controller = new BookingsController(
    {} as BookingsService,
    stream,
  );
  return { controller, stream };
}

describe('BookingsController: GET /bookings/stream (SSE)', () => {
  it('событие шины уходит клиенту типом «booking»', async () => {
    const { controller, stream } = makeController();

    const first = firstValueFrom(controller.stream().pipe(take(1)));
    stream.emit({
      booking: { id: 'b-1', status: 'PENDING' } as BookingDto,
      stats: emptyStats,
    });

    const event = (await first) as MessageEvent;
    expect(event.type).toBe('booking');
    expect(event.data).toMatchObject({
      booking: { id: 'b-1' },
      stats: emptyStats,
    });
  });

  it('heartbeat «ping» каждые 25 c', async () => {
    jest.useFakeTimers();
    try {
      const { controller } = makeController();
      const events: MessageEvent[] = [];
      const sub = controller.stream().subscribe((e) => events.push(e));

      jest.advanceTimersByTime(25_000);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'ping' });
      sub.unsubscribe();
    } finally {
      jest.useRealTimers();
    }
  });
});

import { firstValueFrom } from 'rxjs';
import type { StreamBus } from '../redis/stream-bus';
import { BookingStream, BookingStreamPayload } from './booking-stream';
import type { WaitlistStreamPayload } from '../waitlist/waitlist-events';
import type { ReminderStreamPayload } from '../reminders/reminder-events';

/**
 * Тест двойной роли стрима: emit синхронно будит локальных подписчиков
 * И публикует в шину для соседей; кадр соседа (через onModuleInit-подписку)
 * приходит в тот же subject — SSE-клиентам без разницы, кто эмитил.
 */
function makeStream() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const bus: StreamBus = {
    publish: jest.fn(),
    subscribe: (kind, handler) => handlers.set(kind, handler),
  };
  const stream = new BookingStream(bus);
  stream.onModuleInit();
  return { stream, bus, handlers };
}

const booking: BookingStreamPayload = {
  booking: {
    id: 'b-1',
    status: 'PENDING_PAYMENT',
    seats: ['1-1'],
  } as BookingStreamPayload['booking'],
  stats: {
    PENDING_PAYMENT: 1,
    PENDING: 0,
    CONFIRMED: 0,
    FAILED: 0,
    EXPIRED: 0,
    CANCELLING: 0,
    CANCELLED: 0,
  },
};

describe('BookingStream (unit)', () => {
  it('emit: локальный subject синхронно + publish kind=booking', async () => {
    const { stream, bus } = makeStream();
    const received = firstValueFrom(stream.events$);
    stream.emit(booking);
    expect(await received).toEqual(booking);
    expect(bus.publish).toHaveBeenCalledWith('booking', booking);
  });

  it('чужой кадр booking приходит в events$ как свой', async () => {
    const { stream, handlers } = makeStream();
    const received = firstValueFrom(stream.events$);
    handlers.get('booking')?.(booking);
    expect(await received).toEqual(booking);
  });

  it('waitlist и reminder идут каждый своим каналом', async () => {
    const { stream, handlers, bus } = makeStream();
    const waitlist$ = firstValueFrom(stream.waitlist$);
    const reminder$ = firstValueFrom(stream.reminder$);

    const waitlistPayload = { sessionId: 's-1' } as WaitlistStreamPayload;
    handlers.get('waitlist')?.(waitlistPayload);
    expect(await waitlist$).toEqual(waitlistPayload);

    const reminderPayload = { userId: 'u-1' } as unknown as ReminderStreamPayload;
    handlers.get('reminder')?.(reminderPayload);
    expect(await reminder$).toEqual(reminderPayload);

    expect(bus.publish).not.toHaveBeenCalled(); // доставлено шиной, не emit'ом
  });
});

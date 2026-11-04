import { firstValueFrom } from 'rxjs';
import type { StreamBus } from '../redis/stream-bus';
import { SeatStream } from './seat-stream';

/** как BookingStream: локально синхронно + publish соседям + приём чужих */
function makeStream() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const bus: StreamBus = {
    publish: jest.fn(),
    subscribe: (kind, handler) => handlers.set(kind, handler),
  };
  const stream = new SeatStream(bus);
  stream.onModuleInit();
  return { stream, bus, handlers };
}

describe('SeatStream (unit)', () => {
  it('emit: локальный subject синхронно + publish kind=seat', async () => {
    const { stream, bus } = makeStream();
    const received = firstValueFrom(stream.events$);
    stream.emit({ sessionId: 's-1' });
    expect(await received).toEqual({ sessionId: 's-1' });
    expect(bus.publish).toHaveBeenCalledWith('seat', { sessionId: 's-1' });
  });

  it('чужой кадр seat приходит в events$ — комнаты соседа обновятся', async () => {
    const { stream, handlers } = makeStream();
    const received = firstValueFrom(stream.events$);
    handlers.get('seat')?.({ sessionId: 's-2' });
    expect(await received).toEqual({ sessionId: 's-2' });
  });
});

import type { RawData } from 'ws';
import { SeatMapDto } from './hall';
import { SeatMapGateway } from './seat-map.gateway';
import { SeatStream } from './seat-stream';

/** минимальный двойник ws-сокета: записывает кадры и служебные вызовы */
class FakeSocket {
  sent: unknown[] = [];
  closed: number | null = null;
  terminated = false;
  pings = 0;
  readyState = 1; // OPEN
  private readonly pongHandlers: (() => void)[] = [];

  on(event: string, cb: (...args: unknown[]) => void): void {
    if (event === 'pong') this.pongHandlers.push(cb as () => void);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  close(code = 1000): void {
    this.closed = code;
    this.readyState = 3;
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  /** браузер отвечает на протокольный ping автоматически */
  pong(): void {
    this.pongHandlers.forEach((cb) => cb());
  }
}

function snapshot(sessionId: string, occupied: string[]): SeatMapDto {
  return {
    sessionId,
    layout: { rows: 8, seatsPerRow: 10 },
    occupied,
    free: 80 - occupied.length,
  };
}

/** выждать асинхронный subscribe/broadcast (внутри void-Promise) */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('SeatMapGateway (unit)', () => {
  let seats: SeatStream;
  let seatMap: jest.Mock;
  let gateway: SeatMapGateway;

  beforeEach(() => {
    seats = new SeatStream();
    seatMap = jest.fn(async (sessionId: string) => snapshot(sessionId, []));
    gateway = new SeatMapGateway(
      { seatMap: seatMap as never } as never,
      seats,
    );
  });

  function connect(): FakeSocket {
    const socket = new FakeSocket();
    gateway.handleConnection(socket as never);
    return socket;
  }

  function subscribe(socket: FakeSocket, sessionId: string): void {
    gateway.handleMessage(
      socket as never,
      Buffer.from(JSON.stringify({ type: 'subscribe', sessionId })) as RawData,
    );
  }

  it('subscribe → снапшот текущей карты зала', async () => {
    seatMap.mockResolvedValue(snapshot('s-1', ['1-1', '5-7']));
    const socket = connect();

    subscribe(socket, 's-1');
    await flush();

    expect(socket.sent).toEqual([
      { type: 'snapshot', data: snapshot('s-1', ['1-1', '5-7']) },
    ]);
  });

  it('несуществующий сеанс → error-кадр и close(1008)', async () => {
    seatMap.mockRejectedValue(new Error('not found'));
    const socket = connect();

    subscribe(socket, 's-nope');
    await flush();

    expect(socket.sent).toEqual([
      { type: 'error', message: 'Сеанс не найден' },
    ]);
    expect(socket.closed).toBe(1008);
  });

  it('мусорный JSON и неизвестный тип → error-кадр, соединение живо', async () => {
    const socket = connect();

    gateway.handleMessage(
      socket as never,
      Buffer.from('не json') as RawData,
    );
    gateway.handleMessage(
      socket as never,
      Buffer.from(JSON.stringify({ type: 'wat', sessionId: 's-1' })) as RawData,
    );
    await flush();

    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).toMatchObject({ type: 'error' });
    expect(socket.sent[1]).toMatchObject({ type: 'error' });
    expect(socket.closed).toBeNull();
  });

  it('повторный subscribe переключает комнату — старая пустеет', async () => {
    const socket = connect();
    subscribe(socket, 's-1');
    await flush();
    subscribe(socket, 's-2');
    await flush();
    expect(socket.sent).toHaveLength(2);

    seats.emit({ sessionId: 's-1' });
    await flush();
    expect(socket.sent).toHaveLength(2); // в s-1 клиента больше нет

    seats.emit({ sessionId: 's-2' });
    await flush();
    expect(socket.sent).toHaveLength(3);
  });

  it('сигнал шины → снапшот летит всем клиентам комнаты', async () => {
    const first = connect();
    const second = connect();
    subscribe(first, 's-1');
    subscribe(second, 's-1');
    await flush();

    seatMap.mockResolvedValue(snapshot('s-1', ['2-2']));
    seats.emit({ sessionId: 's-1' });
    await flush();

    expect(first.sent).toHaveLength(2); // подписка + обновление
    expect(second.sent).toHaveLength(2);
    expect(first.sent[1]).toEqual({
      type: 'snapshot',
      data: snapshot('s-1', ['2-2']),
    });
  });

  it('сигнал чужого сеанса и пустая комната → клиентам ничего не уходит', async () => {
    const socket = connect();
    subscribe(socket, 's-1');
    await flush();

    seats.emit({ sessionId: 's-other' });
    await flush();
    expect(socket.sent).toHaveLength(1);
    expect(seatMap).toHaveBeenCalledTimes(1); // и перечитки чужого сеанса нет
  });

  it('disconnect вычищает клиента из комнаты', async () => {
    const socket = connect();
    subscribe(socket, 's-1');
    await flush();

    gateway.handleDisconnect(socket as never);
    seats.emit({ sessionId: 's-1' });
    await flush();

    expect(socket.sent).toHaveLength(1);
    expect(seatMap).toHaveBeenCalledTimes(1);
  });

  it('ping каждые 25 c; молчащий клиент терминируется, ответивший — жив', () => {
    jest.useFakeTimers();
    try {
      gateway.onModuleInit();
      const silent = connect();
      const alive = connect();
      subscribe(silent, 's-1');
      subscribe(alive, 's-1');

      jest.advanceTimersByTime(25_000);
      expect(silent.pings).toBe(1);
      expect(alive.pings).toBe(1);

      alive.pong(); // браузер ответил между тиками
      jest.advanceTimersByTime(25_000);
      expect(silent.terminated).toBe(true);
      expect(alive.terminated).toBe(false);
      expect(alive.pings).toBe(2);
    } finally {
      gateway.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('onModuleDestroy глушит ping и терминирует всех', () => {
    jest.useFakeTimers();
    try {
      gateway.onModuleInit();
      const socket = connect();

      gateway.onModuleDestroy();

      expect(socket.terminated).toBe(true);
      jest.advanceTimersByTime(60_000);
      expect(socket.pings).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

import type { RawData } from 'ws';
import { SeatStream } from '../bookings/seat-stream';
import { GroupGateway } from './group.gateway';
import { GroupRoomStateDto } from './group.gateway';
import { GroupsService } from './groups.service';

/** минимальный двойник ws-сокета (лекало seat-map.gateway.spec) */
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

  pong(): void {
    this.pongHandlers.forEach((cb) => cb());
  }
}

/** выждать асинхронные broadcast'ы (внутри void-Promise) */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function stateFrames(socket: FakeSocket): GroupRoomStateDto[] {
  return socket.sent
    .filter((f): f is { type: 'state'; data: GroupRoomStateDto } =>
      typeof f === 'object' && f !== null && (f as { type?: string }).type === 'state',
    )
    .map((f) => f.data);
}

describe('GroupGateway (unit) — протокол комнаты группы', () => {
  let service: GroupsService;
  let seatMap: jest.Mock;
  let seats: SeatStream;
  let gateway: GroupGateway;
  let nowMs: number;

  beforeEach(() => {
    service = new GroupsService();
    nowMs = 1_700_000_000_000;
    service.now = () => nowMs;
    seatMap = jest.fn(async (sessionId: string) => ({
      sessionId,
      layout: { rows: 8, seatsPerRow: 10 },
      occupied: [] as string[],
      free: 80,
    }));
    seats = new SeatStream({ publish: () => undefined, subscribe: () => undefined });
    gateway = new GroupGateway(service, { seatMap: seatMap as never } as never, seats);
  });

  function connect(): FakeSocket {
    const socket = new FakeSocket();
    gateway.handleConnection(socket as never);
    return socket;
  }

  function send(socket: FakeSocket, frame: unknown): void {
    gateway.handleMessage(socket as never, Buffer.from(JSON.stringify(frame)) as RawData);
  }

  /** группа + вошедший сокет создателя */
  async function roomOf(name: string): Promise<{ code: string; id: string; socket: FakeSocket }> {
    const created = service.create('session-1', name);
    const socket = connect();
    send(socket, { type: 'join', code: created.code, participantId: created.participantId });
    await flush();
    return { code: created.code, id: created.participantId, socket };
  }

  it('join → state-кадр: вы в группе, занятость сеанса, вы онлайн', async () => {
    const room = await roomOf('Алиса');
    const states = stateFrames(room.socket);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      code: room.code,
      sessionId: 'session-1',
      status: 'picking',
      you: room.id,
      occupied: [],
      conflicts: [],
    });
    expect(states[0]!.participants[0]).toMatchObject({
      name: 'Алиса',
      online: true,
      ready: false,
    });
  });

  it('select/ready создателя доводят комнату до fixed', async () => {
    const room = await roomOf('Алиса');
    send(room.socket, { type: 'select', seats: ['5-7', '5-8'] });
    await flush();
    send(room.socket, { type: 'ready', value: true });
    await flush();

    const states = stateFrames(room.socket);
    expect(states.at(-1)!.status).toBe('fixed');
    expect(states.at(-1)!.participants[0]!.seats).toEqual(['5-7', '5-8']);
  });

  it('выбор одного участника виден другому с его цветом', async () => {
    const room = await roomOf('Алиса');
    const boris = connect();
    send(boris, { type: 'join', code: room.code, name: 'Борис' });
    await flush();

    send(room.socket, { type: 'select', seats: ['1-1'] });
    await flush();

    const borisStates = stateFrames(boris);
    const aliosa = borisStates.at(-1)!.participants.find((p) => p.name === 'Алиса')!;
    expect(aliosa.seats).toEqual(['1-1']);
    expect(aliosa.color).toBeTruthy();
    // «кто я» пришёл Борису, выборы Алисы в его кадре
    expect(borisStates.at(-1)!.you).not.toBe(room.id);
  });

  it('мутация без join → error-кадр, соединение живо', async () => {
    const socket = connect();
    send(socket, { type: 'select', seats: ['1-1'] });
    await flush();
    expect(socket.sent[0]).toMatchObject({ type: 'error' });
    expect(socket.closed).toBeNull();
  });

  it('join в несуществующую группу → error-кадр и close(1008)', async () => {
    const socket = connect();
    send(socket, { type: 'join', code: 'ZZZZZZ', name: 'Борис' });
    await flush();
    expect(socket.sent[0]).toMatchObject({ type: 'error' });
    expect(socket.closed).toBe(1008);
  });

  it('мусорный JSON и неизвестный тип → error-кадры', async () => {
    const socket = connect();
    gateway.handleMessage(socket as never, Buffer.from('не json') as RawData);
    send(socket, { type: 'wat' });
    await flush();
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[0]).toMatchObject({ type: 'error' });
    expect(socket.sent[1]).toMatchObject({ type: 'error' });
  });

  it('готовность с конфликтом не фиксирует: конфликты в кадре обоих', async () => {
    const room = await roomOf('Алиса');
    const boris = connect();
    send(boris, { type: 'join', code: room.code, name: 'Борис' });
    await flush();

    send(room.socket, { type: 'select', seats: ['5-7'] });
    send(boris, { type: 'select', seats: ['5-7', '5-8'] });
    send(room.socket, { type: 'ready', value: true });
    send(boris, { type: 'ready', value: true });
    await flush();

    const last = stateFrames(boris).at(-1)!;
    expect(last.status).toBe('picking');
    expect(last.conflicts).toEqual(['5-7']);
  });

  it('внешняя бронь заняла место — шина занятости обновляет occupied комнаты', async () => {
    const room = await roomOf('Алиса');
    expect(stateFrames(room.socket).at(-1)!.occupied).toEqual([]);

    seatMap.mockResolvedValue({
      sessionId: 'session-1',
      layout: { rows: 8, seatsPerRow: 10 },
      occupied: ['5-7'],
      free: 79,
    });
    seats.emit({ sessionId: 'session-1' });
    await flush();

    expect(stateFrames(room.socket).at(-1)!.occupied).toEqual(['5-7']);
  });

  it('disconnect участника — остальные видят offline', async () => {
    const room = await roomOf('Алиса');
    const boris = connect();
    send(boris, { type: 'join', code: room.code, name: 'Борис' });
    await flush();

    gateway.handleDisconnect(boris as never);
    await flush();

    const last = stateFrames(room.socket).at(-1)!;
    const borisView = last.participants.find((p) => p.name === 'Борис')!;
    expect(borisView.online).toBe(false);
  });

  it('leave-кадр: сокет закрыт, комната получила состояние без ушедшего', async () => {
    const room = await roomOf('Алиса');
    const boris = connect();
    send(boris, { type: 'join', code: room.code, name: 'Борис' });
    await flush();

    send(boris, { type: 'leave' });
    await flush();

    expect(boris.closed).toBe(1000);
    const last = stateFrames(room.socket).at(-1)!;
    expect(last.participants.map((p) => p.name)).toEqual(['Алиса']);
  });

  it('booked-кадр ставит бейдж участнику', async () => {
    const room = await roomOf('Алиса');
    send(room.socket, { type: 'select', seats: ['5-7'] });
    send(room.socket, { type: 'ready', value: true });
    await flush();

    send(room.socket, { type: 'booked' });
    await flush();

    expect(stateFrames(room.socket).at(-1)!.participants[0]!.booked).toBe(true);
  });

  it('таймаут группы → финальный кадр disbanded и закрытие сокетов', async () => {
    const room = await roomOf('Алиса');
    nowMs += 16 * 60_000; // idle-окно истекло
    (service as unknown as { sweep(): void }).sweep();
    await flush();

    const last = stateFrames(room.socket).at(-1)!;
    expect(last.status).toBe('disbanded');
    expect(room.socket.closed).toBe(1000);
  });
});

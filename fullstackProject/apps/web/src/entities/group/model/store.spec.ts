/** group store: комната «Идём вместе» по WebSocket — live-ветка (демо в движке отдельно) */
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
import type { GroupRoomState } from '@/shared/api/types';
import { useGroupStore } from '@/entities/group/model/store';

/** двойник WebSocket (лекало movies.store-live.spec) */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  /** серверный кадр в этот сокет */
  serverFrame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const room = (over: Partial<GroupRoomState> = {}): GroupRoomState => ({
  code: 'ABC234',
  sessionId: 's-1',
  status: 'picking',
  expiresAt: Date.now() + 15 * 60_000,
  conflicts: [],
  occupied: [],
  you: 'p-1',
  participants: [
    {
      id: 'p-1',
      name: 'Алиса',
      color: '#22d3ee',
      seats: ['5-7'],
      ready: false,
      booked: false,
      online: true,
    },
  ],
  ...over,
});

describe('group store — live-комната по WebSocket', () => {
  let store: ReturnType<typeof useGroupStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useGroupStore();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('loadPreview: превью группой и ошибка 404 — честный текст', async () => {
    vi.spyOn(api, 'groupPreview').mockResolvedValue(room() as never);
    await store.loadPreview('ABC234');
    expect(store.preview?.code).toBe('ABC234');
    expect(store.previewError).toBeNull();

    vi.spyOn(api, 'groupPreview').mockRejectedValue(new Error('HTTP 404'));
    await store.loadPreview('ZZZZZZ');
    expect(store.preview).toBeNull();
    expect(store.previewError).toContain('Группа не найдена');
  });

  it('create: код группы, participantId переживает F5 в sessionStorage', async () => {
    vi.spyOn(api, 'createGroup').mockResolvedValue({
      code: 'ABC234',
      participantId: 'p-1',
      state: room(),
    });
    const code = await store.create('s-1', 'Алиса');
    expect(code).toBe('ABC234');
    expect(sessionStorage.getItem('cine.group.ABC234')).toBe('p-1');
  });

  it('enter: join-кадр с сохранённой личностью, state-кадр открывает комнату', async () => {
    sessionStorage.setItem('cine.group.ABC234', 'p-1');
    store.enter('ABC234', '');
    const socket = FakeWebSocket.instances.at(-1)!;
    expect(socket.url).toContain('/api/groups');
    socket.onopen!();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'join',
      code: 'ABC234',
      participantId: 'p-1',
    });

    socket.serverFrame({ type: 'state', data: room() });
    expect(store.phase).toBe('room');
    expect(store.room?.participants[0]!.name).toBe('Алиса');
    expect(store.mySeats).toEqual(['5-7']);
    // личность подтверждена сервером — записана на будущее
    expect(sessionStorage.getItem('cine.group.ABC234')).toBe('p-1');
  });

  it('enter без сохранённой личности: join с именем, ответ с you фиксирует id', () => {
    store.enter('ABC234', 'Борис');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen!();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'join',
      code: 'ABC234',
      name: 'Борис',
    });
    socket.serverFrame({ type: 'state', data: room({ you: 'p-2' }) });
    expect(sessionStorage.getItem('cine.group.ABC234')).toBe('p-2');
  });

  it('selectSeats/toggleReady/markBooked шлют кадры открытого сокета', () => {
    store.enter('ABC234', 'Алиса');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen!();
    socket.serverFrame({ type: 'state', data: room() });

    store.selectSeats(['5-7', '5-8']);
    expect(store.mySeats).toEqual(['5-7', '5-8']);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
      type: 'select',
      seats: ['5-7', '5-8'],
    });

    store.toggleReady(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'ready', value: true });

    store.markBooked();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'booked' });
  });

  it('marks: чужие выборы с цветами, свой выбор не помечен', () => {
    store.enter('ABC234', 'Алиса');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen!();
    socket.serverFrame({
      type: 'state',
      data: room({
        participants: [
          room().participants[0]!,
          {
            id: 'p-2',
            name: 'Борис',
            color: '#f472b6',
            seats: ['5-9'],
            ready: false,
            booked: false,
            online: false,
          },
        ],
      }),
    });
    expect(store.marks).toEqual({ '5-9': '#f472b6' });
  });

  it('pendingCount: не готовые участники', () => {
    store.enter('ABC234', 'Алиса');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen!();
    socket.serverFrame({
      type: 'state',
      data: room({
        participants: [
          { ...room().participants[0]!, ready: true },
          {
            id: 'p-2',
            name: 'Борис',
            color: '#f472b6',
            seats: [],
            ready: false,
            booked: false,
            online: true,
          },
        ],
      }),
    });
    expect(store.pendingCount).toBe(1);
  });

  it('кадр disbanded: фаза распада, реконнект не рвётся назад', () => {
    store.enter('ABC234', 'Алиса');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen!();
    socket.serverFrame({ type: 'state', data: room() });
    socket.serverFrame({
      type: 'state',
      data: { ...room(), status: 'disbanded', participants: [], you: null },
    });
    expect(store.phase).toBe('disbanded');
    expect(store.room).toBeNull();

    socket.close(); // сервер закрыл после финального кадра
    expect(FakeWebSocket.instances).toHaveLength(1); // назад не полезли
  });

  it('обрыв связи: backoff-реконнект с повторным join', () => {
    vi.useFakeTimers();
    store.enter('ABC234', 'Алиса');
    const first = FakeWebSocket.instances.at(-1)!;
    first.onopen!();
    first.serverFrame({ type: 'state', data: room() });

    first.onclose!(); // сеть упала
    vi.advanceTimersByTime(1500);
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.onopen!();
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ type: 'join' });
  });

  it('leave: кадр и закрытие потока, фаза распада', () => {
    store.enter('ABC234', 'Алиса');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen!();
    socket.serverFrame({ type: 'state', data: room() });

    store.leave();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'leave' });
    expect(store.phase).toBe('disbanded');
    expect(store.active).toBe(false);
  });

  it('stop: сокет закрыт, epoch вырос — старые колбэки немы', () => {
    store.enter('ABC234', 'Алиса');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.onopen!();
    store.stop();
    expect(socket.closed).toBe(true);
    socket.serverFrame({ type: 'state', data: room() }); // поздний кадр
    expect(store.room).toBeNull();
  });
});

describe('group store — демо-комната движком', () => {
  let store: ReturnType<typeof useGroupStore>;
  let sessionId: string;

  beforeEach(() => {
    setActivePinia(createPinia());
    useAppStore().mode = 'demo';
    store = useGroupStore();
    demoEngine.reset();
    sessionId = demoEngine.movies().data[0]!.sessions[0]!.id;
    sessionStorage.clear();
  });

  it('loadPreview/create через движок', async () => {
    const code = await store.create(sessionId, 'Алиса');
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    await store.loadPreview(code!);
    expect(store.preview?.participants[0]!.name).toBe('Алиса');

    await store.loadPreview('ZZZZZZ');
    expect(store.previewError).toContain('Группа не найдена');
  });

  it('enter демо: комната открывается, мутации идут через движок', () => {
    const created = demoEngine.createGroup(sessionId, 'Алиса');
    sessionStorage.setItem(`cine.group.${created.code}`, created.participantId);

    store.enter(created.code, '');
    expect(store.phase).toBe('room');
    expect(store.me?.name).toBe('Алиса');

    store.selectSeats(['5-7', '5-8']);
    expect(store.mySeats).toEqual(['5-7', '5-8']);
    expect(demoEngine.groupPreview(created.code).participants[0]!.seats).toEqual([
      '5-7',
      '5-8',
    ]);

    store.toggleReady(true);
    expect(demoEngine.groupPreview(created.code).status).toBe('fixed');
    expect(store.room?.status).toBe('fixed');
  });

  it('шаг «Ани» прилетает подпиской на движок', () => {
    const created = demoEngine.createGroup(sessionId, 'Алиса');
    sessionStorage.setItem(`cine.group.${created.code}`, created.participantId);
    store.enter(created.code, '');
    store.selectSeats(['1-1']);

    demoEngine.groupFriendStep(created.code, ['1-1']);
    const names = store.room?.participants.map((p) => p.name) ?? [];
    expect(names).toContain('Аня');
    // чужой выбор виден цветной пометкой
    const anya = store.room?.participants.find((p) => p.name === 'Аня')!;
    expect(store.marks).toEqual(
      Object.fromEntries(anya.seats.map((seat) => [seat, anya.color])),
    );
  });

  it('leave демо: распад последним', () => {
    const created = demoEngine.createGroup(sessionId, 'Алиса');
    sessionStorage.setItem(`cine.group.${created.code}`, created.participantId);
    store.enter(created.code, '');
    store.leave();
    expect(store.phase).toBe('disbanded');
    expect(() => demoEngine.groupPreview(created.code)).toThrow();
  });
});

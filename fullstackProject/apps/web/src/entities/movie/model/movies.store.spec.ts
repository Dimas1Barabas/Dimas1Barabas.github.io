import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type { SeatMap } from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';
import { useMoviesStore } from '@/entities/movie/model/movies.store';

describe('movies store: демо-режим', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    demoEngine.reset();
    useAppStore().mode = 'demo';
  });

  it('грузит из движка и помечает источник', async () => {
    const movies = useMoviesStore();
    await movies.load();

    expect(movies.movies.length).toBeGreaterThan(0);
    expect(['db', 'cache']).toContain(movies.source);
    expect(movies.error).toBeNull();
  });

  it('грузит карту зала сеанса', async () => {
    const movies = useMoviesStore();
    await movies.load();
    await movies.loadSeats(movies.movies[0].sessions[0].id);

    expect(movies.seatMap).not.toBeNull();
    expect(movies.seatMap!.layout).toEqual({ rows: 8, seatsPerRow: 10 });
    expect(movies.seatMap!.free).toBeGreaterThan(0);
  });
});

/** двойник WebSocket: записывает кадры и служебные события */
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

  /** тест поднимает соединение */
  open(): void {
    this.onopen?.();
  }

  /** сервер прислал кадр */
  frame(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  /** сеть пропала без вежливого close */
  drop(): void {
    this.onclose?.();
  }
}

const map = (sessionId: string, occupied: string[]): SeatMap => ({
  sessionId,
  layout: { rows: 8, seatsPerRow: 10 },
  occupied,
  free: 80 - occupied.length,
});

describe('movies store: live-карта по WebSocket', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    useAppStore().mode = 'live';
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    // onopen делает resync через loadSeats → api.seatMap
    vi.spyOn(api, 'seatMap').mockResolvedValue(map('s-1', ['1-1']));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('startSeatStream: сокет /api/seats, subscribe, снапшот применяется', () => {
    const movies = useMoviesStore();
    movies.startSeatStream('s-1');

    const socket = FakeWebSocket.instances.at(-1)!;
    expect(socket.url.startsWith('ws')).toBe(true);
    expect(socket.url.endsWith('/api/seats')).toBe(true);

    socket.open();
    expect(socket.sent).toEqual([
      JSON.stringify({ type: 'subscribe', sessionId: 's-1' }),
    ]);
    // onopen → полный resync, как у SSE
    expect(api.seatMap).toHaveBeenCalledWith('s-1');

    socket.frame({ type: 'snapshot', data: map('s-1', ['1-1', '5-5']) });
    expect(movies.seatMap?.occupied).toEqual(['1-1', '5-5']);
  });

  it('кадр чужого сеанса игнорируется; error-кадр молчит', async () => {
    const movies = useMoviesStore();
    movies.startSeatStream('s-1');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    await flushPromises(); // resync из onopen — асинхронный микротаск

    socket.frame({ type: 'snapshot', data: map('s-other', ['9-9']) });
    expect(movies.seatMap?.occupied).toEqual(['1-1']);

    socket.frame({ type: 'error', message: 'Сеанс не найден' });
    expect(movies.seatMap?.occupied).toEqual(['1-1']);
  });

  it('мусорный кадр не валит поток', () => {
    const movies = useMoviesStore();
    movies.startSeatStream('s-1');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    socket.onmessage?.({ data: 'не json' });
    socket.frame({ type: 'snapshot', data: map('s-1', ['2-2']) });
    expect(movies.seatMap?.occupied).toEqual(['2-2']);
  });

  it('обрыв → реконнект с нарастающим backoff', () => {
    vi.useFakeTimers();
    const movies = useMoviesStore();
    movies.startSeatStream('s-1');
    const first = FakeWebSocket.instances.at(-1)!;
    first.open();

    first.drop(); // первая попытка: ~1 c + jitter
    vi.advanceTimersByTime(1600);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances.at(-1)!;
    second.open();
    second.drop(); // вторая: ~2 c + jitter
    vi.advanceTimersByTime(2600);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(FakeWebSocket.instances.at(-1)!.closed).toBe(false);
  });

  it('stopSeatStream закрывает сокет и отменяет реконнект', () => {
    vi.useFakeTimers();
    const movies = useMoviesStore();
    movies.startSeatStream('s-1');
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();

    movies.stopSeatStream();
    expect(socket.closed).toBe(true);
    expect(movies.seatSocket).toBeNull();
    expect(movies.seatStreamActive).toBe(false);

    const count = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(30_000);
    expect(FakeWebSocket.instances).toHaveLength(count);
  });

  it('повторный старт переключает сеанс: старый сокет закрыт', () => {
    const movies = useMoviesStore();
    movies.startSeatStream('s-1');
    const first = FakeWebSocket.instances.at(-1)!;
    first.open();

    movies.startSeatStream('s-2');
    expect(first.closed).toBe(true);
    const second = FakeWebSocket.instances.at(-1)!;
    second.open();
    second.frame({ type: 'snapshot', data: map('s-2', ['3-3']) });
    expect(movies.seatMap?.occupied).toEqual(['3-3']);
  });
});

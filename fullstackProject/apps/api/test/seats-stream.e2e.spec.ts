/**
 * E2E WS: живая карта мест (/api/seats) — против живого стенда (docker compose up --build).
 * Каркас сьюта — проба health, свой e2e-пользователь на файл, api() —
 * в ./e2e-context. Если API не поднят — тесты файла тихо пропускаются
 * с предупреждением.
 */
import { api, bootstrap, BASE, available } from './e2e-context';
import WebSocket from 'ws';

jest.setTimeout(30_000);

beforeAll(bootstrap);

describe('WS: живая карта мест (/api/seats)', () => {
  const WS_BASE = BASE.replace(/^http/, 'ws');

  type SeatFrame =
    | {
        type: 'snapshot';
        data: { sessionId: string; occupied: string[]; free: number };
      }
    | { type: 'error'; message: string };

  function openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${WS_BASE}/seats`);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  /** следующий кадр с таймаутом — слушателя вешаем ДО мутации */
  function nextFrame(
    socket: WebSocket,
    timeoutMs = 10_000,
  ): Promise<SeatFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('ws-кадр не пришёл')),
        timeoutMs,
      );
      socket.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()) as SeatFrame);
      });
    });
  }

  /** свободное место сеанса — случайное, против коллизий повторных прогонов */
  function freeSeat(occupied: string[]): string {
    const taken = new Set(occupied);
    const candidates: string[] = [];
    for (let row = 1; row <= 8; row++) {
      for (let seat = 1; seat <= 10; seat++) {
        const code = `${row}-${seat}`;
        if (!taken.has(code)) candidates.push(code);
      }
    }
    if (candidates.length === 0) throw new Error('зал переполнен — e2e не может занять место');
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  it('полный цикл: подписка → снапшот; бронь → место занято; отмена → свободно', async () => {
    if (!available) return;
    const movies = await api<{ data: { sessions: { id: string }[] }[] }>('/movies');
    const session = movies.data[0].sessions[0];

    const socket = await openSocket();
    try {
      socket.send(JSON.stringify({ type: 'subscribe', sessionId: session.id }));
      const initial = await nextFrame(socket);
      expect(initial.type).toBe('snapshot');
      if (initial.type !== 'snapshot') return;
      expect(initial.data.sessionId).toBe(session.id);

      const seat = freeSeat(initial.data.occupied);
      const taken = nextFrame(socket);
      const booking = await api<{ id: string }>('/bookings', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: session.id,
          customerName: 'E2E WS',
          seats: [seat],
        }),
      });
      const occupiedFrame = await taken;
      expect(occupiedFrame).toMatchObject({
        type: 'snapshot',
        data: { occupied: expect.arrayContaining([seat]) },
      });

      const freed = nextFrame(socket);
      await api(`/bookings/${booking.id}/cancel`, { method: 'POST' });
      const freeFrame = await freed;
      expect(freeFrame).toMatchObject({ type: 'snapshot' });
      if (freeFrame.type !== 'snapshot') return;
      expect(freeFrame.data.occupied).not.toContain(seat);
      expect(freeFrame.data.free).toBe(initial.data.free);
    } finally {
      socket.close();
    }
  }, 45_000);

  it('несуществующий сеанс → error-кадр и закрытие 1008', async () => {
    if (!available) return;
    const socket = await openSocket();
    try {
      socket.send(
        JSON.stringify({
          type: 'subscribe',
          sessionId: '00000000-0000-0000-0000-000000000000',
        }),
      );
      const frame = await nextFrame(socket);
      expect(frame).toEqual({ type: 'error', message: 'Сеанс не найден' });

      const closed = new Promise<number>((resolve) =>
        socket.once('close', (code) => resolve(code)),
      );
      expect(await closed).toBe(1008);
    } finally {
      socket.close();
    }
  }, 30_000);
});


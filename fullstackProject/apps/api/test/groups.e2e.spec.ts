/**
 * E2E «Идём вместе» (/api/groups) — против живого стенда (docker compose
 * up --build). REST создания/превью + WS-комната: два участника выбирают
 * места, готовы → фиксация; конфликт держит picking; распад по таймауту
 * (стенду задан GROUP_IDLE_TIMEOUT_MS=45 c). Каркас — ./e2e-context;
 * стенд не поднят — тесты файла тихо пропускаются.
 */
import { api, bootstrap, BASE, available } from './e2e-context';
import WebSocket from 'ws';

jest.setTimeout(90_000);

beforeAll(bootstrap);

describe('«Идём вместе»: REST + WS-комната групп', () => {
  const WS_BASE = BASE.replace(/^http/, 'ws');

  type ParticipantDto = {
    id: string;
    name: string;
    color: string;
    seats: string[];
    ready: boolean;
    booked: boolean;
    online: boolean;
  };

  type RoomState = {
    code: string;
    sessionId: string;
    status: 'picking' | 'fixed' | 'disbanded';
    expiresAt: number;
    conflicts: string[];
    occupied: string[];
    you: string | null;
    participants: ParticipantDto[];
  };

  type GroupFrame =
    | { type: 'state'; data: RoomState }
    | { type: 'error'; message: string };

  interface GroupApiResult {
    code: string;
    participantId: string;
    state: {
      code: string;
      sessionId: string;
      status: string;
      expiresAt: number;
      conflicts: string[];
      participants: {
        id: string;
        name: string;
        color: string;
        seats: string[];
        ready: boolean;
        booked: boolean;
      }[];
    };
  }

  function openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${WS_BASE}/groups`);
      socket.once('open', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  /** следующий state-кадр комнаты (error-кадры проваливаются в reject) */
  function nextState(socket: WebSocket, timeoutMs = 10_000): Promise<RoomState> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('ws-кадр не пришёл')),
        timeoutMs,
      );
      socket.once('message', (data) => {
        clearTimeout(timer);
        const frame = JSON.parse(data.toString()) as GroupFrame;
        if (frame.type === 'error') {
          reject(new Error(`error-кадр: ${frame.message}`));
          return;
        }
        resolve(frame.data);
      });
    });
  }

  /** свободное место из карты комнаты (занятые брони + чужие выборы) */
  function freeSeat(state: RoomState, extra: string[] = []): string {
    const taken = new Set([...state.occupied, ...extra]);
    for (let row = 1; row <= 8; row++) {
      for (let seat = 1; seat <= 10; seat++) {
        const code = `${row}-${seat}`;
        if (!taken.has(code)) return code;
      }
    }
    throw new Error('зал переполнен — e2e не может выбрать место');
  }

  async function firstSessionId(): Promise<string> {
    const movies = await api<{ data: { sessions: { id: string }[] }[] }>('/movies');
    return movies.data[0].sessions[0].id;
  }

  it('REST: создание группы на сеанс и превью по коду; чужой код — 404', async () => {
    if (!available) return;
    const sessionId = await firstSessionId();
    const created = await api<GroupApiResult>('/groups', {
      method: 'POST',
      body: JSON.stringify({ sessionId, name: '  E2E  Организатор ' }),
    });
    expect(created.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(created.state.participants[0].name).toBe('E2E Организатор');

    const preview = await api<GroupApiResult['state']>(`/groups/${created.code}`);
    expect(preview.status).toBe('picking');
    expect(preview.sessionId).toBe(sessionId);

    await expect(api('/groups/ZZZZZZ')).rejects.toThrow(/^HTTP 404/);
  }, 30_000);

  it('REST: несуществующий сеанс — 404, как у карты мест', async () => {
    if (!available) return;
    await expect(
      api('/groups', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: '00000000-0000-0000-0000-000000000000',
          name: 'E2E',
        }),
      }),
    ).rejects.toThrow(/^HTTP 404/);
  }, 30_000);

  it('WS: двое выбирают, оба готовы → фиксация; выборы друг друга видны цветом', async () => {
    if (!available) return;
    const sessionId = await firstSessionId();
    const created = await api<GroupApiResult>('/groups', {
      method: 'POST',
      body: JSON.stringify({ sessionId, name: 'Алиса' }),
    });

    const alice = await openSocket();
    const boris = await openSocket();
    try {
      alice.send(
        JSON.stringify({
          type: 'join',
          code: created.code,
          participantId: created.participantId,
        }),
      );
      const aliceState = await nextState(alice);
      expect(aliceState.you).toBe(created.participantId);
      expect(aliceState.participants[0].name).toBe('Алиса');

      boris.send(
        JSON.stringify({ type: 'join', code: created.code, name: 'Борис' }),
      );
      const borisJoined = await nextState(boris);
      expect(borisJoined.participants).toHaveLength(2);
      expect(borisJoined.participants.map((p) => p.color)).toHaveLength(
        new Set(borisJoined.participants.map((p) => p.color)).size,
      );

      // Алиса выбирает — Борис видит её выбор цветной пометкой
      const aliceSeat = freeSeat(borisJoined);
      const borisSeesSelect = nextState(boris);
      alice.send(JSON.stringify({ type: 'select', seats: [aliceSeat] }));
      const borisAfterSelect = await borisSeesSelect;
      const aliceView = borisAfterSelect.participants.find(
        (p) => p.name === 'Алиса',
      )!;
      expect(aliceView.seats).toEqual([aliceSeat]);
      expect(aliceView.color).toMatch(/^#/);

      // оба готовы с непересекающимися выборами → фиксация.
      // Гонка слушателей: кадр готовности Алисы (picking) и кадр фиксации
      // приходят друг за другом — «фиксационные» слушатели вешаем только
      // ПОСЛЕ того, как кадр Алисы съеден отдельным await
      const borisSeat = freeSeat(borisJoined, [aliceSeat]);
      boris.send(JSON.stringify({ type: 'select', seats: [borisSeat] }));
      await nextState(boris);
      alice.send(JSON.stringify({ type: 'ready', value: true }));
      await nextState(alice); // кадр «Алиса готова» (ещё picking) съеден
      const aliceFixed = nextState(alice);
      const borisFixed = nextState(boris);
      boris.send(JSON.stringify({ type: 'ready', value: true }));
      expect((await aliceFixed).status).toBe('fixed');
      expect((await borisFixed).status).toBe('fixed');

      // в fixed выбор менять нельзя
      const refused = nextState(alice);
      alice.send(JSON.stringify({ type: 'select', seats: [aliceSeat, borisSeat] }));
      await expect(refused).rejects.toThrow(/зафиксирован/);

      // снятие готовности размораживает
      const unfrozen = nextState(boris);
      alice.send(JSON.stringify({ type: 'ready', value: false }));
      expect((await unfrozen).status).toBe('picking');

      // обратно к готовности + бейдж брони
      const retranslated = nextState(boris);
      alice.send(JSON.stringify({ type: 'ready', value: true }));
      await retranslated;
      const booked = nextState(alice);
      boris.send(JSON.stringify({ type: 'booked' }));
      const afterBooked = await booked;
      expect(
        afterBooked.participants.find((p) => p.name === 'Борис')!.booked,
      ).toBe(true);
    } finally {
      alice.close();
      boris.close();
    }
  }, 60_000);

  it('WS: конфликт выборов держит picking, место — в conflicts', async () => {
    if (!available) return;
    const sessionId = await firstSessionId();
    const created = await api<GroupApiResult>('/groups', {
      method: 'POST',
      body: JSON.stringify({ sessionId, name: 'Организатор' }),
    });

    const first = await openSocket();
    const second = await openSocket();
    try {
      first.send(
        JSON.stringify({
          type: 'join',
          code: created.code,
          participantId: created.participantId,
        }),
      );
      await nextState(first);
      second.send(
        JSON.stringify({ type: 'join', code: created.code, name: 'Конфликтный' }),
      );
      const both = await nextState(second);
      const seat = freeSeat(both);

      first.send(JSON.stringify({ type: 'select', seats: [seat] }));
      await nextState(first);
      second.send(JSON.stringify({ type: 'select', seats: [seat] }));
      await nextState(second);
      first.send(JSON.stringify({ type: 'ready', value: true }));
      await nextState(first);
      second.send(JSON.stringify({ type: 'ready', value: true }));
      await nextState(second);

      const preview = await api<GroupApiResult['state']>(
        `/groups/${created.code}`,
      );
      // оба готовы, но место оспаривается — фиксации нет
      expect(preview.status).toBe('picking');
      expect(preview.conflicts).toEqual([seat]);
      expect(preview.participants.every((p) => p.ready)).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  }, 60_000);

  it('WS: распад по таймауту — финальный кадр и закрытие; код больше не жив', async () => {
    if (!available) return;
    const sessionId = await firstSessionId();
    const created = await api<GroupApiResult>('/groups', {
      method: 'POST',
      body: JSON.stringify({ sessionId, name: 'Таймаутный' }),
    });

    const socket = await openSocket();
    try {
      socket.send(
        JSON.stringify({
          type: 'join',
          code: created.code,
          participantId: created.participantId,
        }),
      );
      const state = await nextState(socket);
      const windowMs = state.expiresAt - Date.now();
      if (windowMs > 120_000) {
        // стенд с продовыми окнами (k8s: 15/10 минут) — распад не переждать
        // в разумный таймаут прогона; механика распада покрыта юнитами
        // eslint-disable-next-line no-console
        console.warn(
          `\n⚠️  Окно группы ${Math.round(windowMs / 1000)} с — распад не ждём (стенд без GROUP_*_TIMEOUT_MS)\n`,
        );
        return;
      }
      // дедлайн истекает лениво/тиком sweep раз в 15 c — запас на гранулярность
      const waitMs = windowMs + 15_000 + 10_000;
      const disbanded = await nextState(socket, waitMs);
      expect(disbanded.status).toBe('disbanded');

      const closed = new Promise<number>((resolve) =>
        socket.once('close', (code) => resolve(code)),
      );
      expect(await closed).toBe(1000);

      await expect(api(`/groups/${created.code}`)).rejects.toThrow(/^HTTP 404/);
    } finally {
      socket.close();
    }
  }, 150_000);
});

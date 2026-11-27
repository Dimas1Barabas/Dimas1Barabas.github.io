import { defineStore } from 'pinia';
import { api, wsUrl } from '@/shared/api/client';
import type { GroupFrame, GroupRoomState, GroupState } from '@/shared/api/types';

/** ключ sessionStorage: participantId группы — переживает F5, не переживает вкладку */
const participantKey = (code: string): string => `cine.group.${code}`;

function storedParticipantId(code: string): string | null {
  try {
    return sessionStorage.getItem(participantKey(code));
  } catch {
    return null;
  }
}

function saveParticipantId(code: string, participantId: string): void {
  try {
    sessionStorage.setItem(participantKey(code), participantId);
  } catch {
    /* приватный режим — реконнект после F5 станет новым входом, не страшно */
  }
}

/**
 * Стор группы «Идём вместе»: страница-комната /join/:code.
 *
 * Live — WebSocket /api/groups по лекалу живой карты мест (backoff
 * реконнекта, epoch-страж потока): после (пере)подключения join
 * повторяется, participantId из sessionStorage сохраняет личность
 * (цвет, имя, выбор) между перезагрузками страницы. Демо-режим
 * подключается движком страницы (демо-паритет — отдельным модулем).
 */
export const useGroupStore = defineStore('group', {
  state: () => ({
    /** превью по коду — экран приглашения до ввода имени */
    preview: null as GroupState | null,
    previewError: null as string | null,
    previewLoading: false,
    /** состояние комнаты (после успешного join) */
    room: null as GroupRoomState | null,
    /** 'preview' — ссылка открыта; 'room' — вошли; 'disbanded' — распалась */
    phase: 'preview' as 'preview' | 'room' | 'disbanded',
    joining: false,
    lastError: null as string | null,
    /** мой выбор в комнате — v-model карты */
    mySeats: [] as string[],
    /** ws-поток (epoch-страж против гонок перезапуска) */
    socket: null as WebSocket | null,
    epoch: 0,
    active: false,
    code: null as string | null,
    myName: null as string | null,
    retryAttempt: 0,
    retryTimer: null as ReturnType<typeof setTimeout> | null,
  }),
  getters: {
    /** мой участник комнаты (по you из последнего кадра) */
    me(state): GroupRoomState['participants'][number] | null {
      const you = state.room?.you;
      if (!you) return null;
      return state.room?.participants.find((p) => p.id === you) ?? null;
    },
    /** чужие выборы: место → цвет участника (пометки на карте) */
    marks(state): Record<string, string> {
      const result: Record<string, string> = {};
      const you = state.room?.you ?? null;
      for (const p of state.room?.participants ?? []) {
        if (p.id === you) continue;
        for (const seat of p.seats) result[seat] = p.color;
      }
      return result;
    },
    /** сколько участников ещё выбирают (для «ждём N человек») */
    pendingCount(state): number {
      return (state.room?.participants ?? []).filter((p) => !p.ready).length;
    },
  },
  actions: {
    /** превью по коду-приглашению (экран «вас зовут в кино») */
    async loadPreview(code: string): Promise<void> {
      this.previewLoading = true;
      this.previewError = null;
      try {
        this.preview = await api.groupPreview(code);
      } catch {
        this.preview = null;
        this.previewError =
          'Группа не найдена или уже распалась — попросите свежую ссылку';
      } finally {
        this.previewLoading = false;
      }
    },

    /** создать группу из модалки брони: код + ссылка для друзей */
    async create(sessionId: string, name: string): Promise<string | null> {
      this.lastError = null;
      try {
        const res = await api.createGroup({ sessionId, name });
        saveParticipantId(res.code, res.participantId);
        return res.code;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : 'Не получилось';
        return null;
      }
    },

    /** войти в комнату по коду (имя — для нового участника; для
     *  знакомого participantId сервер вернёт прежнюю личность) */
    enter(code: string, name: string): void {
      this.stop();
      this.active = true;
      this.code = code;
      this.myName = name;
      this.phase = 'preview';
      this.joining = true;
      this.connect();
    },

    connect(): void {
      const code = this.code;
      if (!code || !this.active) return;
      const epoch = this.epoch;
      const socket = new WebSocket(wsUrl('/groups'));
      this.socket = socket;
      socket.onopen = () => {
        if (this.epoch !== epoch || !this.active) return;
        this.retryAttempt = 0;
        const participantId = storedParticipantId(code);
        socket.send(
          JSON.stringify({
            type: 'join',
            code,
            ...(this.myName ? { name: this.myName } : {}),
            ...(participantId ? { participantId } : {}),
          }),
        );
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (this.epoch !== epoch || !this.active) return;
        try {
          const frame = JSON.parse(String(ev.data)) as GroupFrame;
          if (frame.type === 'state') this.applyState(frame.data);
          else this.lastError = frame.message;
        } catch {
          /* не-JSON кадр — игнорируем */
        }
      };
      socket.onclose = () => {
        if (this.epoch !== epoch || !this.active) return;
        if (this.phase === 'disbanded') return; // сервер попрощался — не рвёмся назад
        const delay =
          Math.min(1000 * 2 ** this.retryAttempt, 15_000) + Math.random() * 500;
        this.retryAttempt += 1;
        this.retryTimer = setTimeout(() => this.connect(), delay);
      };
    },

    /** применить комнатный кадр: состояние, мой выбор, фазы */
    applyState(state: GroupRoomState): void {
      this.joining = false;
      this.lastError = null;
      if (state.status === 'disbanded') {
        this.phase = 'disbanded';
        this.room = null;
        return;
      }
      this.room = state;
      this.phase = 'room';
      if (state.you) saveParticipantId(state.code, state.you);
      const mine = state.participants.find((p) => p.id === state.you);
      this.mySeats = mine ? [...mine.seats] : [];
    },

    /** заменить свой выбор (замена целиком, сервер валидирует) */
    selectSeats(seats: string[]): void {
      this.mySeats = seats;
      this.send({ type: 'select', seats });
    },

    /** готовность: true требует выбор; все готовы → фиксация на сервере */
    toggleReady(value: boolean): void {
      this.send({ type: 'ready', value });
    },

    /** бронь оформлена — бейдж в панели участников */
    markBooked(): void {
      this.send({ type: 'booked' });
    },

    /** выйти совсем (кнопка «Покинуть группу») */
    leave(): void {
      this.send({ type: 'leave' });
      this.stop();
      this.phase = 'disbanded';
    },

    send(frame: Record<string, unknown>): void {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(frame));
      }
    },

    /** закрыть поток (уход со страницы) — участник остаётся в группе */
    stop(): void {
      this.epoch += 1;
      this.active = false;
      this.joining = false;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      if (this.socket) {
        try {
          this.socket.close();
        } catch {
          /* уже закрыт */
        }
        this.socket = null;
      }
    },

    /** полный сброс (новая ссылка/выход) */
    reset(): void {
      this.stop();
      this.preview = null;
      this.previewError = null;
      this.room = null;
      this.phase = 'preview';
      this.lastError = null;
      this.mySeats = [];
      this.code = null;
      this.myName = null;
    },
  },
});

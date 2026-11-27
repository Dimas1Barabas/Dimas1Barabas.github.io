import { defineStore } from 'pinia';
import { api, wsUrl } from '@/shared/api/client';
import { demoEngine, DEMO_TEST_BUILD } from '@/shared/api/demo-engine';
import { useAppStore } from '@/shared/api/app-mode';
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
    /** демо: отписка от движка и таймер «друга Ани» */
    demoUnsubscribe: null as (() => void) | null,
    friendTimer: null as ReturnType<typeof setTimeout> | null,
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
        this.preview =
          useAppStore().mode === 'demo'
            ? demoEngine.groupPreview(code)
            : await api.groupPreview(code);
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
        const res =
          useAppStore().mode === 'demo'
            ? demoEngine.createGroup(sessionId, name)
            : await api.createGroup({ sessionId, name });
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
      if (useAppStore().mode === 'demo') {
        this.enterDemo(code, name);
        return;
      }
      this.connect();
    },

    /** демо-комната: вход движком + подписка на его шину + «Аня» */
    enterDemo(code: string, name: string): void {
      try {
        const known = storedParticipantId(code) ?? undefined;
        const res = demoEngine.groupJoin(code, name || 'Гость', known);
        saveParticipantId(code, res.participantId);
        this.applyState(
          demoEngine.groupRoomState(code, res.participantId),
        );
        this.demoUnsubscribe = demoEngine.onChange(() => {
          if (!this.active || this.code !== code) return;
          const pid = storedParticipantId(code);
          if (!pid) return;
          try {
            this.applyState(demoEngine.groupRoomState(code, pid));
          } catch {
            /* группа распалась в движке — финальный кадр уже был */
          }
        });
        this.scheduleFriend();
      } catch (err) {
        this.joining = false;
        this.lastError = err instanceof Error ? err.message : 'Группа недоступна';
        this.phase = 'disbanded';
      }
    },

    /** демо: «Аня» делает по одному шагу (вход → выбор → готовность) */
    scheduleFriend(): void {
      if (DEMO_TEST_BUILD) return; // сценарий водит Playwright через движок
      const code = this.code;
      if (!code || !this.active) return;
      this.friendTimer = setTimeout(
        () => {
          if (!this.active || this.code !== code) return;
          demoEngine.groupFriendStep(code, this.mySeats);
          this.scheduleFriend();
        },
        4000 + Math.random() * 4000,
      );
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
      if (this.demoActive()) {
        this.applyDemoMutation((code, pid) =>
          demoEngine.groupSelect(code, pid, seats),
        );
        return;
      }
      this.send({ type: 'select', seats });
    },

    /** готовность: true требует выбор; все готовы → фиксация на сервере */
    toggleReady(value: boolean): void {
      if (this.demoActive()) {
        this.applyDemoMutation((code, pid) =>
          demoEngine.groupReady(code, pid, value),
        );
        return;
      }
      this.send({ type: 'ready', value });
    },

    /** бронь оформлена — бейдж в панели участников */
    markBooked(): void {
      if (this.demoActive()) {
        this.applyDemoMutation((code, pid) => demoEngine.groupBooked(code, pid));
        return;
      }
      this.send({ type: 'booked' });
    },

    /** выйти совсем (кнопка «Покинуть группу») */
    leave(): void {
      if (this.demoActive()) {
        const code = this.code;
        const pid = code ? storedParticipantId(code) : null;
        if (code && pid) {
          try {
            demoEngine.groupLeave(code, pid);
          } catch {
            /* группа уже распалась — уходящему всё равно */
          }
        }
      } else {
        this.send({ type: 'leave' });
      }
      this.stop();
      this.phase = 'disbanded';
    },

    /** демо-поток активен (мод + комната жива) */
    demoActive(): boolean {
      return useAppStore().mode === 'demo' && this.active && !!this.code;
    },

    /** выполнить мутацию движка и применить комнатный кадр */
    applyDemoMutation(
      op: (code: string, pid: string) => GroupRoomState,
    ): void {
      const code = this.code;
      const pid = code ? storedParticipantId(code) : null;
      if (!code || !pid) return;
      try {
        this.applyState(op(code, pid));
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : 'Кадр отклонён';
      }
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
      if (this.friendTimer) {
        clearTimeout(this.friendTimer);
        this.friendTimer = null;
      }
      if (this.demoUnsubscribe) {
        this.demoUnsubscribe();
        this.demoUnsubscribe = null;
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

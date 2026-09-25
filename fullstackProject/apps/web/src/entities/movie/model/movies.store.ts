import { defineStore } from 'pinia';
import { api, wsUrl } from '@/shared/api/client';
import { demoEngine } from '@/shared/api/demo-engine';
import type {
  CreateMoviePayload,
  Movie,
  SeatFrame,
  SeatMap,
  SessionQuote,
} from '@/shared/api/types';
import { useAppStore } from '@/shared/api/app-mode';

export const useMoviesStore = defineStore('movies', {
  state: () => ({
    movies: [] as Movie[],
    /** откуда пришли данные: Redis-кэш или Postgres */
    source: 'db' as 'cache' | 'db',
    loading: false,
    error: null as string | null,
    /** карта занятости зала выбранного фильма (для модалки брони) */
    seatMap: null as SeatMap | null,
    seatsLoading: false,
    /** цена места выбранного сеанса — витрина Тарификатора */
    quote: null as SessionQuote | null,
    quoteLoading: false,
    /** ws-поток живой карты: сеанс подписки и ручной реконнект
     *  (браузерный WebSocket, в отличие от EventSource, сам не вернётся) */
    seatSessionId: null as string | null,
    seatStreamActive: false,
    seatSocket: null as WebSocket | null,
    seatRetryTimer: null as ReturnType<typeof setTimeout> | null,
    seatRetryAttempt: 0,
    /** эпоха потока: старт/стоп инкрементят, замыкания сверяются —
     *  объект сокета в state становится reactive-прокси, идентичность
     *  ненадёжна (грабля Pinia), примитив — надёжен */
    seatEpoch: 0,
    /** демо: отписка от движка и таймер «других зрителей» */
    seatUnsubscribe: null as (() => void) | null,
    seatViewerTimer: null as ReturnType<typeof setTimeout> | null,
    /** места, которые живая карта не должна уводить из-под nose (демо) */
    seatAvoid: null as (() => string[]) | null,
  }),
  actions: {
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      const app = useAppStore();
      try {
        if (app.mode === 'demo') {
          // первый заход — «из БД», дальше — «из кэша», как с Redis в API
          const res = demoEngine.movies();
          this.movies = res.data;
          this.source = res.source;
        } else {
          const res = await api.movies();
          this.movies = res.data;
          this.source = res.source;
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Ошибка загрузки';
      } finally {
        this.loading = false;
      }
    },

    /** Занятость мест не кэшируется — гонка за место решается на бэкенде */
    async loadSeats(sessionId: string): Promise<void> {
      this.seatsLoading = true;
      const app = useAppStore();
      try {
        this.seatMap =
          app.mode === 'demo'
            ? demoEngine.seatMap(sessionId)
            : await api.seatMap(sessionId);
      } finally {
        this.seatsLoading = false;
      }
    },

    /**
     * Цена места сеанса: live — витрина Тарификатора за gRPC (недоступность
     * приходит как dynamic=false с базовой ценой, это не ошибка запроса),
     * демо — зеркало правил движка. Перечитывается при смене сеанса
     * и когда живая карта меняет заполненность (спрос — фактор цены).
     */
    async loadQuote(sessionId: string): Promise<void> {
      this.quoteLoading = true;
      const app = useAppStore();
      try {
        this.quote =
          app.mode === 'demo'
            ? demoEngine.quote(sessionId)
            : await api.sessionQuote(sessionId);
      } catch {
        // сеть умерла — модалка покажет базовую цену афиши
        this.quote = null;
      } finally {
        this.quoteLoading = false;
      }
    },

    /**
     * Живая карта мест по WebSocket: открывается модалкой выбора мест.
     * avoidSeats — места, которые демо-симуляция «других зрителей» не
     * должна занимать (выбор локального пользователя).
     */
    startSeatStream(sessionId: string, avoidSeats?: () => string[]): void {
      this.stopSeatStream();
      const app = useAppStore();
      this.seatSessionId = sessionId;
      this.seatStreamActive = true;
      this.seatAvoid = avoidSeats ?? null;
      this.seatEpoch += 1;
      if (app.mode === 'demo') {
        // демо-«зрители»: пока модалка открыта, движок изредка занимает
        // или освобождает чужое место — живая карта без сети. Мутации
        // движка прилетают через onChange, как SSE у остальных сторов
        this.seatUnsubscribe = demoEngine.onChange(() => {
          if (!this.seatSessionId) return;
          this.applySeatSnapshot(demoEngine.seatMap(this.seatSessionId));
        });
        this.scheduleSeatViewer();
        return;
      }
      this.connectSeatSocket();
    },

    /** демо: следующий «зритель» через случайные 7–15 c (не setInterval —
     *  так интервал дышит и таймер один на поток) */
    scheduleSeatViewer(): void {
      if (!this.seatStreamActive || !this.seatSessionId) return;
      const sessionId = this.seatSessionId;
      const epoch = this.seatEpoch;
      this.seatViewerTimer = setTimeout(
        () => {
          if (this.seatEpoch !== epoch || !this.seatStreamActive) return;
          demoEngine.simulateOtherViewer(sessionId, this.seatAvoid?.() ?? []);
          this.scheduleSeatViewer();
        },
        7000 + Math.random() * 8000,
      );
    },

    /** (пере)подключение к ws-каналу; вызывается стартом и реконнектом */
    connectSeatSocket(): void {
      const sessionId = this.seatSessionId;
      if (!sessionId || !this.seatStreamActive) return;
      const epoch = this.seatEpoch;
      const socket = new WebSocket(wsUrl('/seats'));
      this.seatSocket = socket;
      socket.onopen = () => {
        if (this.seatEpoch !== epoch) return; // поток уже перезапущен/закрыт
        this.seatRetryAttempt = 0;
        socket.send(JSON.stringify({ type: 'subscribe', sessionId }));
        // как у SSE: после (пере)подключения — полный resync поверх кадров
        void this.loadSeats(sessionId);
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (this.seatEpoch !== epoch) return;
        try {
          const frame = JSON.parse(String(ev.data)) as SeatFrame;
          if (frame.type === 'snapshot') this.applySeatSnapshot(frame.data);
          // error-кадр (мусор/чужой сеанс) — показывать нечем, молчим
        } catch {
          /* не-JSON кадр — игнорируем */
        }
      };
      socket.onclose = () => {
        if (this.seatEpoch !== epoch || !this.seatStreamActive) return;
        const delay =
          Math.min(1000 * 2 ** this.seatRetryAttempt, 15_000) +
          Math.random() * 500;
        this.seatRetryAttempt += 1;
        this.seatRetryTimer = setTimeout(() => this.connectSeatSocket(), delay);
      };
    },

    /** закрыть поток: модалка закрыта — карте нечего обновлять */
    stopSeatStream(): void {
      this.seatEpoch += 1;
      this.seatStreamActive = false;
      this.seatSessionId = null;
      this.seatAvoid = null;
      if (this.seatViewerTimer) {
        clearTimeout(this.seatViewerTimer);
        this.seatViewerTimer = null;
      }
      if (this.seatUnsubscribe) {
        this.seatUnsubscribe();
        this.seatUnsubscribe = null;
      }
      if (this.seatRetryTimer) {
        clearTimeout(this.seatRetryTimer);
        this.seatRetryTimer = null;
      }
      if (this.seatSocket) {
        try {
          this.seatSocket.close();
        } catch {
          /* уже закрыт */
        }
        this.seatSocket = null;
      }
      this.seatRetryAttempt = 0;
    },

    /** применить кадр-снапшот; страж от устаревших кадров другого сеанса */
    applySeatSnapshot(map: SeatMap): void {
      if (!this.seatSessionId || map.sessionId !== this.seatSessionId) return;
      this.seatMap = { ...map }; // свежая идентичность — реактивность Vue
    },

    /** новый фильм с сеансами (админ): после создания перезагружаем каталог */
    async create(payload: CreateMoviePayload): Promise<Movie> {
      const movie = await api.createMovie(payload);
      await this.load();
      return movie;
    },
  },
});

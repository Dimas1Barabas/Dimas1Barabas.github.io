import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { RawData, WebSocket } from 'ws';
import type { Subscription } from 'rxjs';
import { Public } from '../auth/public.decorator';
import { SeatMapDto } from './hall';
import { BookingsService } from './bookings.service';
import { SeatStream } from './seat-stream';

/** Кадр сервера → клиент живой карты мест */
export type SeatFrame =
  | { type: 'snapshot'; data: SeatMapDto }
  | { type: 'error'; message: string };

/** Кадр клиента → серверу (после каждого переподключения — заново) */
export interface SeatClientFrame {
  type: 'subscribe';
  sessionId: string;
}

/** readyState открытого сокета (RUNTIME-константу ws не тянем — import type) */
const SOCKET_OPEN = 1;
/** как у SSE-стрима (PING_MS в bookings.controller) */
const PING_MS = 25_000;

/**
 * WS-гейтвей живой карты занятости: ws://…/api/seats.
 *
 * Почему ручная маршрутизация client.on('message'), а не @SubscribeMessage:
 * стандартный WsAdapter ждёт конверт {event, data} и молча глотает всё,
 * что не разобралось (catch → EMPTY), — мы хотим симметричный JSON-протокол
 * и честные error-кадры на мусор.
 *
 * Путь пишем целиком '/api/seats': глобальный префикс 'api' — это HTTP-роутер,
 * на гейтвеи он не действует (адаптер матчить upgrade по точному pathname).
 *
 * Публичен как и SSE-стрим: карта занятости — витринные данные
 * (REST /sessions/:id/seats тоже @Public), EventSource/WebSocket из браузера
 * не отправит Authorization заголовком в руки.
 */
@Public()
@WebSocketGateway({ path: '/api/seats' })
export class SeatMapGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SeatMapGateway.name);
  /** комната сеанса: все, кто открыл выбор мест этого сеанса */
  private readonly rooms = new Map<string, Set<WebSocket>>();
  /** комната клиента — для переключения подписки без повторного коннекта */
  private readonly clientRoom = new Map<WebSocket, string>();
  private readonly clients = new Set<WebSocket>();
  /** дышит ли клиент: pong с последнего ping-тика */
  private readonly alive = new Set<WebSocket>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** подписка на шину мест (в теле конструктора: this.seats ещё не готов
   *  в инициализаторах полей — параметр-свойство присваивается позже) */
  private readonly busSub: Subscription;

  constructor(
    private readonly bookings: BookingsService,
    private readonly seats: SeatStream,
  ) {
    this.busSub = this.seats.events$.subscribe({
      next: ({ sessionId }) => void this.broadcast(sessionId),
    });
  }

  onModuleInit(): void {
    this.pingTimer = setInterval(() => this.pingTick(), PING_MS);
  }

  /** адаптер WsAdapter отдаёт сюда установленное ws-соединение */
  handleConnection(client: WebSocket): void {
    this.clients.add(client);
    this.alive.add(client);
    client.on('pong', () => this.alive.add(client));
    client.on('message', (data: RawData) => this.handleMessage(client, data));
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.alive.delete(client);
    this.leaveRoom(client);
  }

  onModuleDestroy(): void {
    this.busSub.unsubscribe();
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.rooms.clear();
    this.clientRoom.clear();
    this.alive.clear();
  }

  /** ручная маршрутизация кадров: мусор и неизвестный тип — error-кадром
   *  (публичный для юнит-теста маршрутизации) */
  handleMessage(client: WebSocket, data: RawData): void {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      this.sendError(client, 'Кадр не является JSON');
      return;
    }
    if (
      typeof frame !== 'object' ||
      frame === null ||
      (frame as { type?: unknown }).type !== 'subscribe' ||
      typeof (frame as SeatClientFrame).sessionId !== 'string'
    ) {
      this.sendError(client, 'Ожидался кадр {"type":"subscribe","sessionId":…}');
      return;
    }
    const { sessionId } = frame as SeatClientFrame;
    // снапшот сам проверит сеанс: не найден → error-кадр и прощание
    void this.subscribe(client, sessionId);
  }

  private async subscribe(client: WebSocket, sessionId: string): Promise<void> {
    let snapshot: SeatMapDto;
    try {
      snapshot = await this.bookings.seatMap(sessionId);
    } catch {
      this.sendError(client, 'Сеанс не найден');
      client.close(1008);
      return;
    }
    this.leaveRoom(client);
    const room = this.rooms.get(sessionId) ?? new Set<WebSocket>();
    room.add(client);
    this.rooms.set(sessionId, room);
    this.clientRoom.set(client, sessionId);
    this.send(client, { type: 'snapshot', data: snapshot });
  }

  /** изменение занятости — полный снапшот всем, кто смотрит этот сеанс */
  private async broadcast(sessionId: string): Promise<void> {
    const room = this.rooms.get(sessionId);
    if (!room || room.size === 0) return;
    let snapshot: SeatMapDto;
    try {
      snapshot = await this.bookings.seatMap(sessionId);
    } catch {
      return; // сеанс исчез между сигналом и перечиткой — кадры не важны
    }
    for (const client of room) {
      this.send(client, { type: 'snapshot', data: snapshot });
    }
  }

  private leaveRoom(client: WebSocket): void {
    const current = this.clientRoom.get(client);
    if (!current) return;
    this.clientRoom.delete(client);
    const room = this.rooms.get(current);
    if (!room) return;
    room.delete(client);
    if (room.size === 0) this.rooms.delete(current);
  }

  private send(client: WebSocket, frame: SeatFrame): void {
    if (client.readyState !== SOCKET_OPEN) return;
    client.send(JSON.stringify(frame));
  }

  private sendError(client: WebSocket, message: string): void {
    this.send(client, { type: 'error', message });
  }

  /** keepalive: протокольный ping; кто не ответил pong с прошлого тика — терм */
  private pingTick(): void {
    for (const client of this.clients) {
      if (!this.alive.has(client)) {
        client.terminate(); // close-событие поднимет handleDisconnect
        continue;
      }
      this.alive.delete(client);
      client.ping();
    }
  }
}

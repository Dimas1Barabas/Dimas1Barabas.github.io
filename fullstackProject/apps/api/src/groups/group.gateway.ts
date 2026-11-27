import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import type { RawData, WebSocket } from 'ws';
import type { Subscription } from 'rxjs';
import { Public } from '../auth/public.decorator';
import { BookingsService } from '../bookings/bookings.service';
import { SeatStream } from '../bookings/seat-stream';
import {
  GroupStateDto,
  ParticipantDto,
  GroupNotFoundError,
  GroupsService,
} from './groups.service';

/** Кадр сервера → клиенту комнаты группы */
export type GroupFrame =
  | { type: 'state'; data: GroupRoomStateDto }
  | { type: 'error'; message: string };

/** участник комнатного кадра: + онлайн по сокетам комнаты */
export interface RoomParticipantDto extends ParticipantDto {
  online: boolean;
}

/** Комнатное состояние: снапшот группы + занятость сеанса + онлайн + «кто я» */
export type GroupRoomStateDto = Omit<GroupStateDto, 'participants'> & {
  participants: RoomParticipantDto[];
  /** места, занятые внешними бронями (живая карта сеанса) */
  occupied: string[];
  /** id участника этого сокета (после join) */
  you: string | null;
};

/** Кадры клиента → серверу (после каждого переподключения — join заново) */
export type GroupClientFrame =
  | { type: 'join'; code: string; name?: string; participantId?: string }
  | { type: 'select'; seats: string[] }
  | { type: 'ready'; value: boolean }
  | { type: 'booked' }
  | { type: 'leave' };

/** readyState открытого сокета (RUNTIME-константу ws не тянем — import type) */
const SOCKET_OPEN = 1;
/** как у живой карты мест (SeatMapGateway) */
const PING_MS = 25_000;

/**
 * WS-гейтвей комнат групп «Идём вместе»: ws://…/api/groups.
 *
 * Лекало SeatMapGateway: ручная маршрутизация кадров (WsAdapter глотает
 * не-конверты), комнаты по коду группы, протокольный ping 25 c.
 *
 * Протокол: join (знакомый participantId = реконнект с той же личностью)
 * → select/ready/booked/leave. Каждый кадр-изменение рассылается комнате
 * полным снапшотом (снапшоты, не дельты): участники с цветами и выборами,
 * конфликты, статус, занятость сеанса из внешних броней (шину SeatStream
 * слушаем сами — карта и группа видят одно и то же). Распад по таймауту
 * приходит событием сервиса — финальный кадр и закрытие сокетов.
 */
@Public()
@WebSocketGateway({ path: '/api/groups' })
export class GroupGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GroupGateway.name);
  /** комната группы: все сокеты, вошедшие по коду */
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly clientRoom = new Map<WebSocket, string>();
  /** сокет → участник (личность переживает переподключения по participantId) */
  private readonly clientParticipant = new Map<WebSocket, string>();
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new Set<WebSocket>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly seatSub: Subscription;
  private readonly disbandSub: Subscription;

  constructor(
    private readonly groups: GroupsService,
    private readonly bookings: BookingsService,
    seats: SeatStream,
  ) {
    this.seatSub = seats.events$.subscribe({
      next: ({ sessionId }) => void this.occupancyChanged(sessionId),
    });
    this.disbandSub = this.groups.disbands$.subscribe({
      next: (event) => this.groupDisbanded(event.code),
    });
  }

  onModuleInit(): void {
    this.pingTimer = setInterval(() => this.pingTick(), PING_MS);
  }

  handleConnection(client: WebSocket): void {
    this.clients.add(client);
    this.alive.add(client);
    client.on('pong', () => this.alive.add(client));
    client.on('message', (data: RawData) => this.handleMessage(client, data));
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    this.alive.delete(client);
    const code = this.clientRoom.get(client);
    this.clientParticipant.delete(client);
    this.leaveSocketRoom(client);
    // онлайн-состав комнаты изменился — панель участников обновится у всех
    if (code) void this.broadcast(code);
  }

  onModuleDestroy(): void {
    this.seatSub.unsubscribe();
    this.disbandSub.unsubscribe();
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.rooms.clear();
    this.clientRoom.clear();
    this.clientParticipant.clear();
    this.alive.clear();
  }

  /** ручная маршрутизация кадров (публично для юнит-теста) */
  handleMessage(client: WebSocket, data: RawData): void {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      this.sendError(client, 'Кадр не является JSON');
      return;
    }
    if (typeof frame !== 'object' || frame === null) {
      this.sendError(client, 'Кадр не является объектом');
      return;
    }
    const msg = frame as Partial<GroupClientFrame>;
    switch (msg.type) {
      case 'join':
        void this.join(client, msg.code, msg.name, msg.participantId);
        return;
      case 'select':
        void this.mutate(client, (code, participantId) =>
          this.groups.setSelection(code, participantId, msg.seats ?? []),
        );
        return;
      case 'ready':
        void this.mutate(client, (code, participantId) =>
          this.groups.setReady(code, participantId, msg.value === true),
        );
        return;
      case 'booked':
        void this.mutate(client, (code, participantId) =>
          this.groups.markBooked(code, participantId),
        );
        return;
      case 'leave':
        void this.leave(client);
        return;
      default:
        this.sendError(client, 'Неизвестный тип кадра');
    }
  }

  /** вход по коду: знакомый participantId — та же личность, новый — новый участник */
  private async join(
    client: WebSocket,
    code: unknown,
    name: unknown,
    participantId: unknown,
  ): Promise<void> {
    if (typeof code !== 'string' || code.length === 0) {
      this.sendError(client, 'Кадр join требует код группы');
      return;
    }
    try {
      const res = this.groups.join(
        code,
        name,
        typeof participantId === 'string' && participantId.length > 0
          ? participantId
          : undefined,
      );
      this.leaveSocketRoom(client);
      const room = this.rooms.get(code) ?? new Set<WebSocket>();
      room.add(client);
      this.rooms.set(code, room);
      this.clientRoom.set(client, code);
      this.clientParticipant.set(client, res.participantId);
      await this.broadcast(code);
    } catch (err) {
      this.logger.debug(`join ${code} отклонён: ${String(err)}`);
      this.sendError(client, err instanceof Error ? err.message : 'Группа недоступна');
      client.close(1008);
    }
  }

  /** обёртка мутаций: код/участник из подписки сокета, ошибки — error-кадром */
  private async mutate(
    client: WebSocket,
    op: (code: string, participantId: string) => unknown,
  ): Promise<void> {
    const code = this.clientRoom.get(client);
    const participantId = this.clientParticipant.get(client);
    if (!code || !participantId) {
      this.sendError(client, 'Сначала войдите в группу (кадр join)');
      return;
    }
    try {
      op(code, participantId);
      await this.broadcast(code);
    } catch (err) {
      if (err instanceof GroupNotFoundError) {
        // группа распалась между кадрами — финальный кадр и прощание
        this.sendError(client, err.message);
        client.close(1008);
        return;
      }
      this.sendError(client, err instanceof Error ? err.message : 'Кадр отклонён');
    }
  }

  /** явный уход: участник удаляется, сокет прощается с комнатой */
  private async leave(client: WebSocket): Promise<void> {
    const code = this.clientRoom.get(client);
    const participantId = this.clientParticipant.get(client);
    if (!code || !participantId) {
      this.sendError(client, 'Сначала войдите в группу (кадр join)');
      return;
    }
    this.leaveSocketRoom(client);
    this.clientParticipant.delete(client);
    try {
      this.groups.leave(code, participantId);
    } catch {
      /* группа уже распалась — молча: уходящего это не должно волновать */
    }
    client.close(1000);
    await this.broadcast(code);
  }

  /** занятость сеанса изменилась (внешняя бронь) — комнатам этого сеанса свежий кадр */
  private async occupancyChanged(sessionId: string): Promise<void> {
    for (const code of this.sessionRooms(sessionId)) {
      await this.broadcast(code);
    }
  }

  /** таймаут распал группу: финальный кадр и закрытие сокетов комнаты */
  private groupDisbanded(code: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const frame: GroupFrame = {
      type: 'state',
      data: {
        code,
        sessionId: '',
        status: 'disbanded',
        expiresAt: 0,
        conflicts: [],
        participants: [],
        occupied: [],
        you: null,
      },
    };
    for (const client of room) {
      this.send(client, frame);
      client.close(1000);
    }
    for (const client of room) {
      this.leaveSocketRoom(client);
      this.clientParticipant.delete(client);
    }
  }

  /** полный снапшот комнате: состояние + занятость + онлайн + «кто я» */
  private async broadcast(code: string): Promise<void> {
    const room = this.rooms.get(code);
    if (!room || room.size === 0) return;
    const state = this.groups.snapshot(code);
    if (!state) return; // распалась между событием и рассылкой — кадр распада уже был
    const occupied = await this.safeOccupied(state.sessionId);
    const online = this.onlineOf(code);
    const participants = state.participants.map((p) => ({
      ...p,
      online: online.has(p.id),
    }));
    for (const client of room) {
      this.send(client, {
        type: 'state',
        data: {
          ...state,
          participants,
          occupied,
          you: this.clientParticipant.get(client) ?? null,
        },
      });
    }
  }

  /** перечитать занятость сеанса; сеанс исчез — считаем пусто (группу это не убивает) */
  private async safeOccupied(sessionId: string): Promise<string[]> {
    try {
      const seatMap = await this.bookings.seatMap(sessionId);
      return seatMap.occupied;
    } catch {
      return [];
    }
  }

  /** онлайн-состав комнаты по participantId */
  private onlineOf(code: string): Set<string> {
    const online = new Set<string>();
    const room = this.rooms.get(code);
    if (!room) return online;
    for (const client of room) {
      const participantId = this.clientParticipant.get(client);
      if (participantId) online.add(participantId);
    }
    return online;
  }

  /** коды комнат, чья группа смотрит этот сеанс */
  private sessionRooms(sessionId: string): string[] {
    const codes: string[] = [];
    for (const code of this.rooms.keys()) {
      if (this.groups.sessionIdOf(code) === sessionId) codes.push(code);
    }
    return codes;
  }

  private leaveSocketRoom(client: WebSocket): void {
    const current = this.clientRoom.get(client);
    if (!current) return;
    this.clientRoom.delete(client);
    const room = this.rooms.get(current);
    if (!room) return;
    room.delete(client);
    if (room.size === 0) this.rooms.delete(current);
  }

  private send(client: WebSocket, frame: GroupFrame): void {
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

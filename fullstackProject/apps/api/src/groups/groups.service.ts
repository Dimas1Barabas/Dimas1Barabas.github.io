import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import {
  MAX_PARTICIPANTS,
  Participant,
  GroupStatus,
  colorFor,
  everyoneReady,
  generateGroupCode,
  isValidSelection,
  normalizeName,
  selectionConflicts,
} from './group.logic';
import { groupFixedTimeoutMs, groupIdleTimeoutMs } from './group-timeouts';

/** Группа не найдена / уже распалась */
export class GroupNotFoundError extends Error {
  constructor() {
    super('Группа не найдена или распалась');
  }
}

/** В группе максимум MAX_PARTICIPANTS мест (столько цветов в палитре) */
export class GroupFullError extends Error {
  constructor() {
    super('В группе уже максимум участников');
  }
}

/** Имя участника не прошло нормализацию */
export class NameInvalidError extends Error {
  constructor() {
    super('Имя участника — от 2 до 60 символов');
  }
}

/** Выбор мест не прошёл валидацию зала/лимитов */
export class SelectionInvalidError extends Error {
  constructor() {
    super('Выбор: до 8 мест зала без дублей, коды «ряд-место»');
  }
}

/** «Готов» с пустым выбором нельзя — нечего будет бронировать */
export class ReadyNeedsSeatsError extends Error {
  constructor() {
    super('Сначала выберите места');
  }
}

/** Мутация выбора в зафиксированной группе */
export class GroupFixedError extends Error {
  constructor() {
    super('Выбор зафиксирован — снимите готовность, чтобы менять');
  }
}

/** Участник группы для витрины состояния */
export interface ParticipantDto {
  id: string;
  name: string;
  color: string;
  seats: string[];
  ready: boolean;
  booked: boolean;
}

/** Полное состояние группы — рассылается комнате целиком (снапшоты, не дельты) */
export interface GroupStateDto {
  code: string;
  sessionId: string;
  status: GroupStatus;
  /** дедлайн распада (activity в picking, фиксации в fixed) */
  expiresAt: number;
  /** места, оспариваемые несколькими участниками */
  conflicts: string[];
  participants: ParticipantDto[];
}

/** Результат create/join — идентичность участника для WS-реконнектов */
export interface JoinGroupResult {
  code: string;
  participantId: string;
  state: GroupStateDto;
}

/** Событие распада: гейтвей разошлёт комнате финальный кадр и закроет сокеты */
export interface GroupDisbandedEvent {
  code: string;
  sessionId: string;
  reason: 'timeout';
}

interface GroupRecord {
  code: string;
  sessionId: string;
  createdAt: number;
  status: GroupStatus;
  participants: Map<string, Participant>;
  /** picking: последняя активность + idle-окно */
  activityDeadline: number;
  /** fixed: момент фиксации (для fixed-окна) */
  fixedAt: number | null;
}

/** Период подчистки просроченных групп (группы живут минуты — реже не нужно) */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * In-memory стор групп «Идём вместе».
 *
 * Группа эфемерна по природе (таймаут сам её распускает), поэтому БД нет:
 * рестарт API = распад всех групп — честное поведение для координационного
 * слоя. Все мутации возвращают/перечитывают состояние целиком — гейтвей
 * рассылает полные снапшоты. Часы и случайность вынесены в поля для тестов.
 */
@Injectable()
export class GroupsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GroupsService.name);
  private readonly groups = new Map<string, GroupRecord>();
  private readonly disbandSubject = new Subject<GroupDisbandedEvent>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** распады по таймауту — гейтвей разошлёт финальные кадры */
  readonly disbands$ = this.disbandSubject.asObservable();

  /** часы/случайность — поля для подмены в тестах */
  now: () => number = () => Date.now();
  randomCode: () => string = generateGroupCode;

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.disbandSubject.complete();
    this.groups.clear();
  }

  /** создать группу: создатель сразу первый участник */
  create(sessionId: string, rawName: unknown): JoinGroupResult {
    const name = normalizeName(rawName);
    if (name === null) throw new NameInvalidError();
    const code = this.freshCode();
    const participant: Participant = {
      id: randomUUID(),
      name,
      colorIndex: 0,
      seats: [],
      ready: false,
      booked: false,
      joinedAt: this.now(),
    };
    const record: GroupRecord = {
      code,
      sessionId,
      createdAt: participant.joinedAt,
      status: 'picking',
      participants: new Map([[participant.id, participant]]),
      activityDeadline: participant.joinedAt + groupIdleTimeoutMs(),
      fixedAt: null,
    };
    this.groups.set(code, record);
    return { code, participantId: participant.id, state: this.stateOf(record) };
  }

  /**
   * Войти по коду-приглашению. Знакомый participantId — реконнект:
   * та же личность и цвет (имя из ссылки не перезатирает первое).
   */
  join(code: string, rawName: unknown, participantId?: string): JoinGroupResult {
    const record = this.live(code);
    if (!record) throw new GroupNotFoundError();
    if (participantId) {
      const known = record.participants.get(participantId);
      if (known) {
        this.touch(record);
        return { code, participantId, state: this.stateOf(record) };
      }
    }
    if (record.participants.size >= MAX_PARTICIPANTS) throw new GroupFullError();
    const name = normalizeName(rawName);
    if (name === null) throw new NameInvalidError();
    const participant: Participant = {
      id: randomUUID(),
      name,
      colorIndex: record.participants.size,
      seats: [],
      ready: false,
      booked: false,
      joinedAt: this.now(),
    };
    record.participants.set(participant.id, participant);
    this.touch(record);
    return { code, participantId: participant.id, state: this.stateOf(record) };
  }

  /** заменить свой выбор целиком (только в picking; смена выбора снимает готовность) */
  setSelection(code: string, participantId: string, seats: string[]): GroupStateDto {
    const record = this.live(code);
    if (!record) throw new GroupNotFoundError();
    const participant = this.member(record, participantId);
    if (record.status === 'fixed') throw new GroupFixedError();
    if (!Array.isArray(seats) || !isValidSelection(seats)) {
      throw new SelectionInvalidError();
    }
    const changed = participant.seats.join('|') !== seats.join('|');
    participant.seats = [...seats];
    // «Готов» — согласие с конкретным выбором: сменил выбор — снова не готов
    if (changed && participant.ready) participant.ready = false;
    this.recompute(record);
    this.touch(record);
    return this.stateOf(record);
  }

  /** готовность участника: true требует выбор; все готовы → фиксация (без конфликтов) */
  setReady(code: string, participantId: string, value: boolean): GroupStateDto {
    const record = this.live(code);
    if (!record) throw new GroupNotFoundError();
    const participant = this.member(record, participantId);
    if (value && participant.seats.length === 0) throw new ReadyNeedsSeatsError();
    participant.ready = value;
    this.recompute(record);
    this.touch(record);
    return this.stateOf(record);
  }

  /** участник забронировал свои места после фиксации (витринный бейдж) */
  markBooked(code: string, participantId: string): GroupStateDto {
    const record = this.live(code);
    if (!record) throw new GroupNotFoundError();
    const participant = this.member(record, participantId);
    participant.booked = true;
    return this.stateOf(record);
  }

  /** выйти совсем: выбор и готовность уходят вместе с участником */
  leave(code: string, participantId: string): GroupStateDto | null {
    const record = this.live(code);
    if (!record) throw new GroupNotFoundError();
    this.member(record, participantId);
    record.participants.delete(participantId);
    if (record.participants.size === 0) {
      this.disband(record, 'timeout');
      return null;
    }
    this.recompute(record);
    this.touch(record);
    return this.stateOf(record);
  }

  /** снапшот состояния (null — группы нет/распалась) */
  snapshot(code: string): GroupStateDto | null {
    const record = this.live(code);
    return record ? this.stateOf(record) : null;
  }

  /** sessionId группы — гейтвею для фильтра шины занятости */
  sessionIdOf(code: string): string | null {
    const record = this.live(code);
    return record ? record.sessionId : null;
  }

  /** живая запись с ленивой экспирацией: просроченная — распадается на месте */
  private live(code: string): GroupRecord | null {
    const record = this.groups.get(code);
    if (!record) return null;
    if (this.now() >= this.deadlineOf(record)) {
      this.disband(record, 'timeout');
      return null;
    }
    return record;
  }

  private member(record: GroupRecord, participantId: string): Participant {
    const participant = record.participants.get(participantId);
    if (!participant) throw new GroupNotFoundError();
    return participant;
  }

  /** активность отодвигает распад только в picking: fixed-окно не продлевается */
  private touch(record: GroupRecord): void {
    if (record.status === 'picking') {
      record.activityDeadline = this.now() + groupIdleTimeoutMs();
    }
  }

  /**
   * Пересчёт статуса после мутации: все готовы без конфликтов → fixed,
   * иначе picking. Снятие готовности в fixed размораживает выбор —
   * так группа чинит ситуацию «место за время фиксации заняли внешней
   * бронью»: участники возвращаются к выбору.
   */
  private recompute(record: GroupRecord): void {
    const participants = [...record.participants.values()];
    const wasFixed = record.status === 'fixed';
    if (everyoneReady(participants)) {
      const conflicts = selectionConflicts(participants);
      if (conflicts.size > 0) {
        // оспариваемые места не дают зафиксироваться — вызывающий увидит
        // их в state.conflicts и подсветит участникам
        record.status = 'picking';
        return;
      }
      if (!wasFixed) record.fixedAt = this.now();
      record.status = 'fixed';
    } else {
      record.status = 'picking';
      record.fixedAt = null;
    }
  }

  private deadlineOf(record: GroupRecord): number {
    return record.status === 'fixed' && record.fixedAt !== null
      ? record.fixedAt + groupFixedTimeoutMs()
      : record.activityDeadline;
  }

  private stateOf(record: GroupRecord): GroupStateDto {
    const participants = [...record.participants.values()];
    return {
      code: record.code,
      sessionId: record.sessionId,
      status: record.status,
      expiresAt: this.deadlineOf(record),
      conflicts: [...selectionConflicts(participants).keys()],
      participants: participants.map((p) => ({
        id: p.id,
        name: p.name,
        color: colorFor(p.colorIndex),
        seats: [...p.seats],
        ready: p.ready,
        booked: p.booked,
      })),
    };
  }

  /** код без коллизий с живыми группами (перегенерация — копеечная редкость) */
  private freshCode(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = this.randomCode();
      if (!this.groups.has(code)) return code;
    }
    return `${this.randomCode()}${this.now().toString(36).slice(-2)}`.toUpperCase();
  }

  private sweep(): void {
    const now = this.now();
    for (const record of [...this.groups.values()]) {
      if (now >= this.deadlineOf(record)) this.disband(record, 'timeout');
    }
  }

  private disband(record: GroupRecord, reason: GroupDisbandedEvent['reason']): void {
    this.groups.delete(record.code);
    this.disbandSubject.next({ code: record.code, sessionId: record.sessionId, reason });
    this.logger.log(`группа ${record.code} распалась (${reason})`);
  }
}

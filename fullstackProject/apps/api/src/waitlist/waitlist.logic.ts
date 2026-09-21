import {
  ConflictException,
  GoneException,
  HttpException,
} from '@nestjs/common';
import { WaitlistEntry } from './waitlist.entity';

/**
 * Чистая логика очереди — один источник для API и (зеркалом) демо-режима
 * на фронте. Все функции работают по выгрузке записей сеанса без БД.
 */

/** Очередь сеанса: WAITING-записи от старейшей к новой (позиция = индекс + 1). */
export function waitingQueue(entries: WaitlistEntry[]): WaitlistEntry[] {
  return entries
    .filter((e) => e.status === 'WAITING')
    .sort(
      (a, b) =>
        a.queuedAt.getTime() - b.queuedAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

/** Позиция записи среди WAITING (1 — голова); null — записи в очереди нет. */
export function positionOf(
  entries: WaitlistEntry[],
  entryId: string,
): number | null {
  const idx = waitingQueue(entries).findIndex((e) => e.id === entryId);
  return idx === -1 ? null : idx + 1;
}

/**
 * Голова очереди — кому сообщаем об освободившемся месте.
 * null — очередь пуста (никто не WAITING).
 */
export function pickNextToNotify(
  entries: WaitlistEntry[],
): WaitlistEntry | null {
  return waitingQueue(entries)[0] ?? null;
}

/** причины отказа во входе в лист ожидания */
export type WaitlistJoinRefusal =
  | 'waitlistAlready'
  | 'sessionNotFull'
  | 'sessionPassed';

/** база ссылки «к выбору мест» в письме листа ожидания */
export function webLinkBase(): string {
  return process.env.WEB_LINK_BASE ?? 'http://localhost:18080/#/';
}

/**
 * Отказ по коду — единый источник для join и повторного join
 * (по образцу promoRefusalError: тело с code, фронт различает причины).
 */
export function waitlistRefusalError(code: WaitlistJoinRefusal): HttpException {
  switch (code) {
    case 'waitlistAlready':
      return new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Вы уже в листе ожидания этого сеанса',
        code,
      });
    case 'sessionNotFull':
      return new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'На сеансе есть свободные места — лист ожидания не нужен',
        code,
      });
    case 'sessionPassed':
      return new GoneException({
        statusCode: 410,
        error: 'Gone',
        message: 'Сеанс уже начался — лист ожидания закрыт',
        code,
      });
  }
}

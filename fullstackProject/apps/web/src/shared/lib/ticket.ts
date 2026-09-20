/**
 * QR-билеты: зеркало чистой логики API (apps/api/src/bookings/ticket.logic.ts) —
 * экран билета и симуляция в демо-режиме собирают QR-строку и подпись
 * так же, как их выдаёт и проверяет живой API.
 */

import { isValidSeat } from './hall';
import { hmacSha256Hex, sha256Hex } from './sha256';

/** версия формата QR-строки — на случай эволюции payload */
export const TICKET_QR_VERSION = 'CINE1';

/** сигнатура — первые 128 бит HMAC-SHA256 (hex): QR остаётся разреженным */
export const TICKET_SIGNATURE_HEX = 32;

/**
 * Секрет демо-режима. Отличен от dev-секрета стенда — подписи демо и
 * live не взаимозаменяемы (демо-билеты не пройдут у живого сканера).
 */
export const DEMO_TICKETS_SECRET = 'demo-cine-tickets-secret';

/** каноническая строка билета — ровно то, что уходит под подпись */
export function ticketCanonical(
  bookingId: string,
  seat: string,
  sessionAt: string,
): string {
  return [
    TICKET_QR_VERSION,
    bookingId,
    seat,
    Math.floor(Date.parse(sessionAt) / 1000),
  ].join('|');
}

/** HMAC-SHA256 канонической строки, hex, усечённый до 128 бит */
export function signTicket(
  canonical: string,
  secret: string = DEMO_TICKETS_SECRET,
): string {
  return hmacSha256Hex(secret, canonical).slice(0, TICKET_SIGNATURE_HEX);
}

/**
 * Сравнение подписей. В API — timingSafeEqual (сканер — наружный вход);
 * демо не защищает от тайминг-атак, здесь достаточно простого равенства.
 */
export function ticketSignatureMatches(
  canonical: string,
  signature: string,
  secret: string = DEMO_TICKETS_SECRET,
): boolean {
  return signTicket(canonical, secret) === signature;
}

export interface ParsedTicketQr {
  canonical: string;
  bookingId: string;
  seat: string;
  sessionAt: string;
  signature: string;
}

/**
 * Разбирает QR-строку `CINE1|bookingId|seat|epoch|sig`.
 * null — формат чужой: не та версия, не 5 частей, кривое место,
 * бессмысленный epoch или подпись не похожа на hex-128.
 */
export function parseTicketQr(payload: string): ParsedTicketQr | null {
  const parts = payload.split('|');
  if (parts.length !== 5 || parts[0] !== TICKET_QR_VERSION) return null;
  const [, bookingId, seat, epoch, signature] = parts;
  if (!bookingId || !/^[0-9a-f]{32}$/.test(signature)) return null;
  if (!isValidSeat(seat) || !/^\d{9,13}$/.test(epoch)) return null;
  return {
    canonical: [TICKET_QR_VERSION, bookingId, seat, epoch].join('|'),
    bookingId,
    seat,
    sessionAt: new Date(Number(epoch) * 1000).toISOString(),
    signature,
  };
}

/** человекочитаемый номер: детерминирован канонической строкой (sha256 → base36) */
export function ticketNoOf(canonical: string): string {
  const hash = sha256Hex(`TICKET-NO|${canonical}`);
  const num = BigInt(`0x${hash.slice(0, 10)}`); // 40 бит → ≤8 знаков base36
  return `TK-${num.toString(36).toUpperCase().padStart(6, '0').slice(0, 6)}`;
}

/** QR-строка билета «на вход в зал»: каноническая часть + подпись из TicketDto */
export function ticketQrOf(ticket: {
  bookingId: string;
  seat: string;
  sessionAt: string;
  signature: string;
}): string {
  return `${ticketCanonical(
    ticket.bookingId,
    ticket.seat,
    ticket.sessionAt,
  )}|${ticket.signature}`;
}

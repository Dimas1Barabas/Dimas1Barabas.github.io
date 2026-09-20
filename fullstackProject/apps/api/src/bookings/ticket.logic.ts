import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiProperty } from '@nestjs/swagger';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { Booking } from './booking.entity';
import { isValidSeat } from './hall';

/**
 * QR-билет — производная брони, а не отдельная сущность: билеты есть
 * ровно тогда, когда бронь CONFIRMED, и умирают вместе с ней (сага
 * возврата закрывает бронь — билеты гаснут сами, REFUND_FAILED
 * откатывает в CONFIRMED — оживают). Подпись детерминирована
 * (бронь + место + сеанс), поэтому хранить и синхронизировать нечего:
 * каждый запрос пересчитывает её заново из тех же входных данных.
 */

/** версия формата QR-строки — на случай эволюции payload */
export const TICKET_QR_VERSION = 'CINE1';

/** сигнатура — первые 128 бит HMAC-SHA256 (hex): компромисс между
 * стойкостью к подделке и плотностью QR-кода */
const SIGNATURE_HEX = 32;

/** секрет подписи; дефолт — только для dev (как JWT_SECRET) */
export const DEFAULT_TICKETS_SECRET = 'dev-cine-tickets-secret';

/**
 * Читается из process.env напрямую, без ConfigService — как PAYMENT_TIMEOUT_MS:
 * подпись считается чистой функцией вне DI.
 */
export function ticketsSecret(): string {
  return process.env.TICKETS_SECRET ?? DEFAULT_TICKETS_SECRET;
}

/** каноническая строка билета — ровно то, что уходит под подпись */
export function ticketCanonical(
  bookingId: string,
  seat: string,
  sessionAt: Date,
): string {
  return [
    TICKET_QR_VERSION,
    bookingId,
    seat,
    Math.floor(sessionAt.getTime() / 1000),
  ].join('|');
}

/** HMAC-SHA256 канонической строки, hex, усечён до 128 бит */
export function signTicket(
  canonical: string,
  secret: string = ticketsSecret(),
): string {
  return createHmac('sha256', secret)
    .update(canonical)
    .digest('hex')
    .slice(0, SIGNATURE_HEX);
}

/** сравнение подписей без утечки по времени (сканер — наружный вход) */
export function ticketSignatureMatches(
  canonical: string,
  signature: string,
  secret: string = ticketsSecret(),
): boolean {
  const expected = Buffer.from(signTicket(canonical, secret), 'utf8');
  const presented = Buffer.from(signature, 'utf8');
  return (
    expected.length === presented.length &&
    timingSafeEqual(expected, presented)
  );
}

export interface ParsedTicketQr {
  canonical: string;
  bookingId: string;
  seat: string;
  sessionAt: Date;
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
    sessionAt: new Date(Number(epoch) * 1000),
    signature,
  };
}

/** человекочитаемый номер: детерминирован канонической строкой (sha256 → base36) */
export function ticketNoOf(canonical: string): string {
  const hash = createHash('sha256')
    .update(`TICKET-NO|${canonical}`)
    .digest('hex');
  const num = BigInt(`0x${hash.slice(0, 10)}`); // 40 бит → ≤8 знаков base36
  return `TK-${num.toString(36).toUpperCase().padStart(6, '0').slice(0, 6)}`;
}

/** класс (не interface) — чтобы попадать в OpenAPI-схему ответов */
export class TicketDto {
  @ApiProperty({ format: 'uuid' })
  bookingId!: string;

  @ApiProperty({ example: '5-7', description: 'код «ряд-место»' })
  seat!: string;

  @ApiProperty({
    example: 'TK-59U3V4',
    description: 'номер билета — детерминирован (бронь + место + сеанс)',
  })
  ticketNo!: string;

  @ApiProperty({
    example: '2e0254421e0f61336e75bd1c6af05d99',
    description: 'HMAC-SHA256 канонической строки, первые 128 бит (hex)',
  })
  signature!: string;

  @ApiProperty({ example: 'Рекурсия' })
  movieTitle!: string;

  @ApiProperty({ example: 275, description: 'оттенок постера фильма' })
  movieHue!: number;

  @ApiProperty({ example: '🌀' })
  movieGenreIcon!: string;

  @ApiProperty({ format: 'date-time' })
  sessionAt!: string;

  @ApiProperty({ example: 'IMAX' })
  hall!: string;

  @ApiProperty({ example: 'Дмитрий' })
  customerName!: string;
}

export function toTicketDto(
  booking: Booking,
  movie: Movie,
  session: Session,
  seat: string,
): TicketDto {
  const canonical = ticketCanonical(booking.id, seat, session.startsAt);
  return {
    bookingId: booking.id,
    seat,
    ticketNo: ticketNoOf(canonical),
    signature: signTicket(canonical),
    movieTitle: movie.title ?? '—',
    movieHue: movie.hue ?? 220,
    movieGenreIcon: movie.genreIcon ?? '🎟️',
    sessionAt: session.startsAt.toISOString(),
    hall: session.hall ?? '—',
    customerName: booking.customerName,
  };
}

export const TICKET_REFUSAL_REASONS = [
  'malformedPayload',
  'badSignature',
  'bookingNotFound',
  'bookingNotConfirmed',
  'seatMismatch',
  'sessionPassed',
] as const;

export type TicketRefusalReason = (typeof TICKET_REFUSAL_REASONS)[number];

/** ответ сканера: вердикт + контекст для экрана контролёра */
export class TicketVerifyResultDto {
  @ApiProperty({ example: true })
  valid!: boolean;

  /** union-тип в reflect-metadata неразличим — перечисляем явно */
  @ApiProperty({
    enum: TICKET_REFUSAL_REASONS,
    nullable: true,
    description: 'причина отказа (null — билет валиден)',
  })
  reason!: TicketRefusalReason | null;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  bookingId!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '5-7' })
  seat!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Рекурсия' })
  movieTitle!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  sessionAt!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'IMAX' })
  hall!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Дмитрий' })
  customerName!: string | null;
}

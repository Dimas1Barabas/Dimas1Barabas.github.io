import { createHmac } from 'node:crypto';
import { Booking } from './booking.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import {
  DEFAULT_TICKETS_SECRET,
  ParsedTicketQr,
  TICKET_QR_VERSION,
  parseTicketQr,
  signTicket,
  ticketCanonical,
  ticketNoOf,
  ticketSignatureMatches,
  toTicketDto,
} from './ticket.logic';

/**
 * Эталонные векторы фиксируют формат НАДЁЖНО: каноническая строка,
 * длина и значение подписи. Те же входные данные зеркалятся в спеке
 * веб-логики (apps/web/src/shared/lib/ticket.spec.ts) — так демо-режим
 * и API продолжат считать подпись одинаково (см. промокодный прецедент).
 */
const SECRET = 'vector-secret';
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_AT = new Date(1_789_713_600_000); // 2026-09-18T08:00:00Z
const CANONICAL_5_7 = `${TICKET_QR_VERSION}|${BOOKING_ID}|5-7|1789713600`;

/** независимо от реализации — считаем эталон напрямую node:crypto */
function referenceSignature(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 32);
}

describe('ticketCanonical', () => {
  it('склеивает версию, бронь, место и epoch секунды сеанса', () => {
    expect(ticketCanonical(BOOKING_ID, '5-7', SESSION_AT)).toBe(CANONICAL_5_7);
  });

  it('дробное время сеанса не меняет epoch-часть', () => {
    const withMillis = new Date(SESSION_AT.getTime() + 999);
    expect(ticketCanonical(BOOKING_ID, '5-7', withMillis)).toBe(CANONICAL_5_7);
  });
});

describe('signTicket', () => {
  it('HMAC-SHA256, усечённый до 128 бит — эталонный вектор', () => {
    expect(signTicket(CANONICAL_5_7, SECRET)).toBe(
      referenceSignature(CANONICAL_5_7, SECRET),
    );
    expect(signTicket(CANONICAL_5_7, SECRET)).toHaveLength(32);
  });

  it('детерминирован: одна входная строка — одна подпись', () => {
    expect(signTicket(CANONICAL_5_7, SECRET)).toBe(signTicket(CANONICAL_5_7, SECRET));
  });

  it('место меняет подпись — каждый билет подписан отдельно', () => {
    const other = ticketCanonical(BOOKING_ID, '5-8', SESSION_AT);
    expect(signTicket(other, SECRET)).not.toBe(signTicket(CANONICAL_5_7, SECRET));
  });

  it('секрет меняет подпись — смена секрета гасит старые билеты', () => {
    expect(signTicket(CANONICAL_5_7, 'another-secret')).not.toBe(
      signTicket(CANONICAL_5_7, SECRET),
    );
  });

  it('дефолтный секрет — dev-значение (как JWT_SECRET)', () => {
    expect(signTicket(CANONICAL_5_7)).toBe(
      signTicket(CANONICAL_5_7, DEFAULT_TICKETS_SECRET),
    );
  });
});

describe('ticketSignatureMatches', () => {
  it('истина для правильной подписи', () => {
    const sig = signTicket(CANONICAL_5_7, SECRET);
    expect(ticketSignatureMatches(CANONICAL_5_7, sig, SECRET)).toBe(true);
  });

  it('ложь для подделки (перевёрнутая подпись)', () => {
    const sig = signTicket(CANONICAL_5_7, SECRET);
    const flipped = sig.split('').reverse().join('');
    expect(ticketSignatureMatches(CANONICAL_5_7, flipped, SECRET)).toBe(false);
  });

  it('ложь для подписи чужой длины — без исключения', () => {
    expect(ticketSignatureMatches(CANONICAL_5_7, 'abc', SECRET)).toBe(false);
  });
});

describe('parseTicketQr', () => {
  const qrOf = (canonical: string, secret = SECRET) =>
    `${canonical}|${signTicket(canonical, secret)}`;

  it('разбирает валидную строку и восстанавливает каноническую', () => {
    const parsed = parseTicketQr(qrOf(CANONICAL_5_7)) as ParsedTicketQr;
    expect(parsed).not.toBeNull();
    expect(parsed.canonical).toBe(CANONICAL_5_7);
    expect(parsed.bookingId).toBe(BOOKING_ID);
    expect(parsed.seat).toBe('5-7');
    expect(parsed.sessionAt).toEqual(SESSION_AT);
    expect(parsed.signature).toBe(signTicket(CANONICAL_5_7, SECRET));
  });

  it.each([
    ['мусор', 'просто строка'],
    ['не та версия', qrOf(CANONICAL_5_7).replace('CINE1', 'CINE0')],
    ['лишняя часть', `${qrOf(CANONICAL_5_7)}|extra`],
    ['место вне формата', qrOf(ticketCanonical(BOOKING_ID, 'row5', SESSION_AT))],
    ['место вне зала', qrOf(ticketCanonical(BOOKING_ID, '9-1', SESSION_AT))],
    ['epoch не число', qrOf(CANONICAL_5_7).replace('1789713600', 'сейчас')],
    ['подпись не hex', qrOf(CANONICAL_5_7).replace(/[0-9a-f]{32}$/, 'X'.repeat(32))],
    ['подпись короче', qrOf(CANONICAL_5_7).slice(0, -10)],
  ])('отвергает строку: %s', (_label, payload) => {
    expect(parseTicketQr(payload)).toBeNull();
  });
});

describe('ticketNoOf', () => {
  it('формат TK-XXXXXX и детерминирован', () => {
    expect(ticketNoOf(CANONICAL_5_7)).toMatch(/^TK-[0-9A-Z]{6}$/);
    expect(ticketNoOf(CANONICAL_5_7)).toBe(ticketNoOf(CANONICAL_5_7));
  });

  it('у каждого места свой номер', () => {
    const other = ticketCanonical(BOOKING_ID, '5-8', SESSION_AT);
    expect(ticketNoOf(other)).not.toBe(ticketNoOf(CANONICAL_5_7));
  });
});

describe('toTicketDto', () => {
  const movie: Movie = {
    id: 'movie-1',
    title: 'Рекурсия',
    genreIcon: '🌀',
    hue: 275,
  } as Movie;
  const session: Session = {
    id: 'session-1',
    hall: 'IMAX',
    startsAt: SESSION_AT,
  } as Session;
  const booking: Booking = {
    id: BOOKING_ID,
    customerName: 'Дмитрий',
    seats: ['5-7'],
  } as Booking;

  it('подпись и номер — от канонической строки этого места', () => {
    const dto = toTicketDto(booking, movie, session, '5-7');

    expect(dto).toMatchObject({
      bookingId: BOOKING_ID,
      seat: '5-7',
      signature: signTicket(CANONICAL_5_7),
      ticketNo: ticketNoOf(CANONICAL_5_7),
      movieTitle: 'Рекурсия',
      movieHue: 275,
      movieGenreIcon: '🌀',
      sessionAt: SESSION_AT.toISOString(),
      hall: 'IMAX',
      customerName: 'Дмитрий',
    });
  });
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEMO_TICKETS_SECRET,
  TICKET_QR_VERSION,
  ParsedTicketQr,
  parseTicketQr,
  signTicket,
  ticketCanonical,
  ticketNoOf,
  ticketQrOf,
  ticketSignatureMatches,
} from './ticket';

/**
 * Зеркало спека API (apps/api/src/bookings/ticket.logic.spec.ts): те же
 * входные данные и эталонные векторы — подпись демо и live считается
 * одинаково, расходится только секрет.
 */
const SECRET = 'vector-secret';
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
/** 1789713600 = 2026-09-18T08:00:00Z — фиксируем epoch-часть канона */
const SESSION_AT = new Date(1_789_713_600_000).toISOString();
const CANONICAL_5_7 = `${TICKET_QR_VERSION}|${BOOKING_ID}|5-7|1789713600`;

function referenceSignature(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex').slice(0, 32);
}

describe('ticketCanonical', () => {
  it('склеивает версию, бронь, место и epoch секунды сеанса', () => {
    expect(ticketCanonical(BOOKING_ID, '5-7', SESSION_AT)).toBe(CANONICAL_5_7);
  });
});

describe('signTicket', () => {
  it('та же подпись, что у node:crypto (API) на том же входе', () => {
    expect(signTicket(CANONICAL_5_7, SECRET)).toBe(
      referenceSignature(CANONICAL_5_7, SECRET),
    );
    expect(signTicket(CANONICAL_5_7, SECRET)).toHaveLength(32);
  });

  it('детерминирован; место меняет подпись', () => {
    expect(signTicket(CANONICAL_5_7, SECRET)).toBe(signTicket(CANONICAL_5_7, SECRET));
    const other = ticketCanonical(BOOKING_ID, '5-8', SESSION_AT);
    expect(signTicket(other, SECRET)).not.toBe(signTicket(CANONICAL_5_7, SECRET));
  });

  it('дефолтный секрет демо отличен от dev-секрета стенда', () => {
    expect(signTicket(CANONICAL_5_7)).toBe(
      signTicket(CANONICAL_5_7, DEMO_TICKETS_SECRET),
    );
    expect(DEMO_TICKETS_SECRET).not.toBe('dev-cine-tickets-secret');
  });
});

describe('ticketSignatureMatches', () => {
  it('истина для правильной подписи, ложь для подделки', () => {
    const sig = signTicket(CANONICAL_5_7, SECRET);
    expect(ticketSignatureMatches(CANONICAL_5_7, sig, SECRET)).toBe(true);
    expect(ticketSignatureMatches(CANONICAL_5_7, '0'.repeat(32), SECRET)).toBe(false);
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
    expect(parsed.sessionAt).toBe(SESSION_AT);
    expect(parsed.signature).toBe(signTicket(CANONICAL_5_7, SECRET));
  });

  it.each([
    ['мусор', 'просто строка'],
    ['не та версия', qrOf(CANONICAL_5_7).replace('CINE1', 'CINE0')],
    ['лишняя часть', `${qrOf(CANONICAL_5_7)}|extra`],
    ['место вне формата', qrOf(ticketCanonical(BOOKING_ID, 'row5', SESSION_AT))],
    ['epoch не число', qrOf(CANONICAL_5_7).replace('1789713600', 'сейчас')],
    ['подпись не hex', qrOf(CANONICAL_5_7).replace(/[0-9a-f]{32}$/, 'X'.repeat(32))],
  ])('отвергает строку: %s', (_label, payload) => {
    expect(parseTicketQr(payload)).toBeNull();
  });
});

describe('ticketNoOf', () => {
  it('формат TK-XXXXXX, детерминирован, у каждого места свой', () => {
    expect(ticketNoOf(CANONICAL_5_7)).toMatch(/^TK-[0-9A-Z]{6}$/);
    expect(ticketNoOf(CANONICAL_5_7)).toBe(ticketNoOf(CANONICAL_5_7));
    const other = ticketCanonical(BOOKING_ID, '5-8', SESSION_AT);
    expect(ticketNoOf(other)).not.toBe(ticketNoOf(CANONICAL_5_7));
  });
});

describe('ticketQrOf', () => {
  it('собирает QR-строку из полей Ticket — как экран «на входе в зал»', () => {
    const signature = signTicket(CANONICAL_5_7);
    const qr = ticketQrOf({
      bookingId: BOOKING_ID,
      seat: '5-7',
      sessionAt: SESSION_AT,
      signature,
    });
    expect(qr).toBe(`${CANONICAL_5_7}|${signature}`);
    // и она же проходит собственный парсер
    expect(parseTicketQr(qr)?.canonical).toBe(CANONICAL_5_7);
  });
});

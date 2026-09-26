/**
 * Демо-движок: QR-билеты — зеркало контракта API и Go-воркера.
 * Общие хелперы спек — в ./demo-spec-helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoEngine } from '@/shared/api/demo-engine';
import { ApiError } from '@/shared/api/client';
import { signTicket, ticketCanonical, ticketQrOf } from '@/shared/lib/ticket';
import { firstFreeSeats } from '@/shared/api/demo-spec-helpers';

describe('demoEngine: QR-билеты', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    demoEngine.reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('QR-билеты', () => {
    /** сеанс в будущем — сканер честно отвергает прошедшие сеансы */
    function futureSession() {
      for (const movie of demoEngine.movies().data) {
        const session = movie.sessions.find(
          (s) => Date.parse(s.startsAt) > Date.now(),
        );
        if (session) return { movie, session };
      }
      throw new Error('в демо-фикстуре нет будущих сеансов');
    }

    /** оплаченная бронь, доведённая «воркером» до CONFIRMED */
    async function confirmedBooking(seatCount: number) {
      const { session } = futureSession();
      const seats = firstFreeSeats(demoEngine.seatMap(session.id), seatCount);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      const booking = demoEngine.create({
        sessionId: session.id,
        customerName: 'Билетник',
        seats,
      });
      demoEngine.pay(booking.id);
      await vi.advanceTimersByTimeAsync(3000);
      randomSpy.mockRestore();
      expect(booking.status).toBe('CONFIRMED');
      return booking;
    }

    it('CONFIRMED: по билету на место, подпись hex-128, номер TK-XXXXXX', async () => {
      const booking = await confirmedBooking(2);

      const tickets = demoEngine.tickets(booking.id);
      expect(tickets).toHaveLength(2);
      expect(tickets.map((t) => t.seat)).toEqual(booking.seats);
      for (const ticket of tickets) {
        expect(ticket.signature).toMatch(/^[0-9a-f]{32}$/);
        expect(ticket.ticketNo).toMatch(/^TK-[0-9A-Z]{6}$/);
        expect(ticket.movieTitle).toBe(booking.movieTitle);
        expect(ticket.hall).toBe(booking.hall);
        expect(ticket.sessionAt).toBe(booking.sessionAt);
      }
      // производная без состояния: повторная выдача — те же подписи
      expect(demoEngine.tickets(booking.id)).toEqual(tickets);
    });

    it('409 bookingNotConfirmed до подтверждения; 404 неизвестная бронь', async () => {
      const { session } = futureSession();
      const seats = firstFreeSeats(demoEngine.seatMap(session.id), 1);
      const pending = demoEngine.create({
        sessionId: session.id,
        customerName: 'Рано',
        seats,
      });

      try {
        demoEngine.tickets(pending.id);
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('bookingNotConfirmed');
      }

      try {
        demoEngine.tickets('нет-такой');
        throw new Error('ожидали 404');
      } catch (err) {
        expect((err as ApiError).status).toBe(404);
      }
    });

    it('сканер: честный QR — valid, подделка — badSignature, мусор — malformedPayload', async () => {
      const booking = await confirmedBooking(1);
      const [ticket] = demoEngine.tickets(booking.id);

      const honest = ticketQrOf(ticket);
      expect(demoEngine.verifyTicket(honest)).toMatchObject({
        valid: true,
        reason: null,
        bookingId: booking.id,
        seat: ticket.seat,
        movieTitle: booking.movieTitle,
        customerName: 'Билетник',
      });

      const forged = honest.slice(0, -32) + '0'.repeat(32);
      expect(demoEngine.verifyTicket(forged)).toMatchObject({
        valid: false,
        reason: 'badSignature',
      });

      expect(demoEngine.verifyTicket('мусор')).toMatchObject({
        valid: false,
        reason: 'malformedPayload',
      });
    });

    it('сканер: чужое место — seatMismatch (подпись честная)', async () => {
      const booking = await confirmedBooking(1);
      const seat = booking.seats.includes('8-10') ? '8-9' : '8-10';
      const canonical = ticketCanonical(booking.id, seat, booking.sessionAt);

      const verdict = demoEngine.verifyTicket(`${canonical}|${signTicket(canonical)}`);

      expect(verdict).toMatchObject({ valid: false, reason: 'seatMismatch', seat });
    });

    it('сага возврата: CANCELLED гасит билеты, откат в CONFIRMED оживляет', async () => {
      const booking = await confirmedBooking(1);
      expect(demoEngine.tickets(booking.id)).toHaveLength(1);

      // «банк» отклоняет возврат — бронь откатывается в CONFIRMED
      const failSpy = vi.spyOn(Math, 'random').mockReturnValue(0.95);
      demoEngine.cancel(booking.id);
      await vi.advanceTimersByTimeAsync(2000);
      failSpy.mockRestore();
      expect(booking.status).toBe('CONFIRMED');
      expect(demoEngine.tickets(booking.id)).toHaveLength(1); // оживили

      // успешный возврат закрывает бронь — билеты гаснут
      const okSpy = vi.spyOn(Math, 'random').mockReturnValue(0.1);
      demoEngine.cancel(booking.id);
      await vi.advanceTimersByTimeAsync(2000);
      okSpy.mockRestore();
      expect(booking.status).toBe('CANCELLED');
      try {
        demoEngine.tickets(booking.id);
        throw new Error('ожидали 409');
      } catch (err) {
        expect((err as ApiError).status).toBe(409);
        expect(JSON.parse((err as ApiError).body).code).toBe('bookingNotConfirmed');
      }
    });
  });
});

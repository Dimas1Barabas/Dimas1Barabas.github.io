/**
 * BookingsService (unit): QR-билеты: выдача и сканер.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { buildBookingsHarness, type BookingsHarness, sessionFixture, authUser, bookingFixture } from './bookings.service.harness';
import { signTicket, ticketCanonical } from './ticket.logic';

describe('BookingsService: QR-билеты: выдача и сканер (unit)', () => {
  let service: BookingsHarness['service'];
  let bookingsRepo: BookingsHarness['bookingsRepo'];
  let sessionsRepo: BookingsHarness['sessionsRepo'];

  beforeEach(async () => {
    ({ service, bookingsRepo, sessionsRepo } = await buildBookingsHarness());
  });

  describe('tickets', () => {
    beforeEach(() => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CONFIRMED',
      });
    });

    it('по билету на каждое место: подпись hex-128 и номер TK-XXXXXX', async () => {
      const result = await service.tickets('booking-1', authUser);

      expect(result).toHaveLength(3); // места 5-7, 5-8, 5-9
      expect(result.map((t) => t.seat)).toEqual(['5-7', '5-8', '5-9']);
      for (const ticket of result) {
        expect(ticket.bookingId).toBe('booking-1');
        expect(ticket.signature).toMatch(/^[0-9a-f]{32}$/);
        expect(ticket.ticketNo).toMatch(/^TK-[0-9A-Z]{6}$/);
        expect(ticket.movieTitle).toBe('Рекурсия');
        expect(ticket.hall).toBe('IMAX');
        expect(ticket.customerName).toBe('Дмитрий');
      }
      // каждое место подписано отдельно
      const sigs = new Set(result.map((t) => t.signature));
      expect(sigs.size).toBe(3);
    });

    it('подпись детерминирована: повторная выдача — те же билеты', async () => {
      const first = await service.tickets('booking-1', authUser);
      const second = await service.tickets('booking-1', authUser);

      expect(second.map((t) => t.signature)).toEqual(
        first.map((t) => t.signature),
      );
      expect(second.map((t) => t.ticketNo)).toEqual(
        first.map((t) => t.ticketNo),
      );
    });

    it('403: чужие билеты не выдаются', async () => {
      const promise = service.tickets('booking-1', {
        ...authUser,
        id: 'user-2',
        name: 'Гость',
      });

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('409 bookingNotConfirmed: бронь ещё не подтверждена', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });

      const promise = service.tickets('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({
        code: 'bookingNotConfirmed',
        status: 'PENDING_PAYMENT',
      });
    });

    it('409 bookingNotConfirmed: отменённая бронь гасит билеты', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLED',
      });

      const promise = service.tickets('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({ code: 'bookingNotConfirmed' });
    });
  });

  describe('verifyTicket', () => {
    /** сеанс в будущем — критерий живого билета */
    const startsAt = new Date(Date.now() + 3_600_000);
    const canonicalOf = (seat: string) => ticketCanonical('booking-1', seat, startsAt);
    const qrOf = (seat: string) => `${canonicalOf(seat)}|${signTicket(canonicalOf(seat))}`;

    beforeEach(() => {
      bookingsRepo.findOneBy.mockResolvedValue({
        ...bookingFixture(),
        status: 'CONFIRMED',
      });
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt,
      });
    });

    it('валидный билет → true с контекстом для экрана контролёра', async () => {
      const verdict = await service.verifyTicket(qrOf('5-7'));

      expect(verdict).toMatchObject({
        valid: true,
        reason: null,
        bookingId: 'booking-1',
        seat: '5-7',
        movieTitle: 'Рекурсия',
        hall: 'IMAX',
        customerName: 'Дмитрий',
      });
    });

    it('подделка подписи → false, badSignature', async () => {
      const payload = `${canonicalOf('5-7')}|${'0'.repeat(32)}`;

      const verdict = await service.verifyTicket(payload);

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'badSignature',
        seat: '5-7',
      });
      // подделку отсеивает подпись — до БД дело не доходит
      expect(bookingsRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('мусорная строка → false, malformedPayload', async () => {
      const verdict = await service.verifyTicket('не QR-строка');

      expect(verdict).toMatchObject({ valid: false, reason: 'malformedPayload' });
      expect(bookingsRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('бронь не найдена → false, bookingNotFound', async () => {
      bookingsRepo.findOneBy.mockResolvedValue(null);

      const verdict = await service.verifyTicket(qrOf('5-7'));

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'bookingNotFound',
        bookingId: 'booking-1',
      });
    });

    it('бронь не подтверждена → false, bookingNotConfirmed', async () => {
      bookingsRepo.findOneBy.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLED',
      });

      const verdict = await service.verifyTicket(qrOf('5-7'));

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'bookingNotConfirmed',
      });
    });

    it('чужое место (подпись честная) → false, seatMismatch', async () => {
      // место существует в зале, но брони не принадлежит; подпись
      // посчитана правильно — отсеивает именно состав мест брони
      const verdict = await service.verifyTicket(qrOf('8-10'));

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'seatMismatch',
        seat: '8-10',
      });
    });

    it('сеанс уже прошёл → false, sessionPassed', async () => {
      const past = new Date(Date.now() - 3_600_000);
      const canonical = ticketCanonical('booking-1', '5-7', past);
      const payload = `${canonical}|${signTicket(canonical)}`;
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt: past,
      });

      const verdict = await service.verifyTicket(payload);

      expect(verdict).toMatchObject({
        valid: false,
        reason: 'sessionPassed',
        movieTitle: 'Рекурсия',
      });
    });
  });

});

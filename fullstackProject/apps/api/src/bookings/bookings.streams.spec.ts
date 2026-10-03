/**
 * BookingsService (unit): шины: SSE и живая карта.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */
import { ConflictException } from '@nestjs/common';
import { buildBookingsHarness, type BookingsHarness, authUser, bookingFixture } from './bookings.service.harness';

describe('BookingsService: шины: SSE и живая карта (unit)', () => {
  let service: BookingsHarness['service'];
  let bookingsRepo: BookingsHarness['bookingsRepo'];
  let stream: BookingsHarness['stream'];
  let seatStream: BookingsHarness['seatStream'];
  let emInsert: BookingsHarness['emInsert'];
  let emUpdate: BookingsHarness['emUpdate'];

  beforeEach(async () => {
    ({ service, bookingsRepo, stream, seatStream, emInsert, emUpdate } = await buildBookingsHarness());
  });

  describe('SSE: уведомление подключённых клиентов', () => {
    it('create → событие с новой бронью и статистикой', async () => {
      await service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['1-1'],
        },
        authUser,
      );

      expect(stream.emit).toHaveBeenCalledTimes(1);
      const payload = stream.emit.mock.calls[0][0];
      expect(payload.booking).toMatchObject({
        movieId: 'movie-1',
        sessionId: 'session-1',
        hall: 'IMAX',
        status: 'PENDING_PAYMENT',
        movieTitle: 'Рекурсия',
      });
      expect(payload.stats).toEqual({
        PENDING_PAYMENT: 0,
        PENDING: 0,
        CONFIRMED: 0,
        FAILED: 0,
        EXPIRED: 0,
        CANCELLING: 0,
        CANCELLED: 0,
      });
    });

    it('handleProcessed → событие с вердиктом воркера', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(stream.emit).toHaveBeenCalledTimes(1);
      const payload = stream.emit.mock.calls[0][0];
      expect(payload.booking.status).toBe('CONFIRMED');
    });

    it('пропущенный ределивери → без события', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      expect(stream.emit).not.toHaveBeenCalled();
    });
  });

  describe('живая карта: сигнал SeatStream', () => {
    it('create (места заняты) → сигнал по сеансу', async () => {
      await service.create(
        { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['1-1'] },
        authUser,
      );

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('конфликт мест → без сигнала (транзакция откатилась)', async () => {
      emInsert.mockRejectedValue({ code: '23505' });

      await expect(
        service.create(
          { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['1-1'] },
          authUser,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(seatStream.emit).not.toHaveBeenCalled();
    });

    it('отмена неоплаченной → сигнал (места свободны)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });

      await service.cancel('booking-1', authUser);

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('FAILED-вердикт воркера → сигнал', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'FAILED',
        message: 'Банк отказал',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('EXPIRED по TTL → сигнал', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'EXPIRED',
      });

      await service.handleExpired({
        bookingId: 'booking-1',
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: '2026-09-03T12:15:00Z',
      });

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('возврат по саге (CANCELLED) → сигнал', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLING',
      });

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      expect(seatStream.emit).toHaveBeenCalledTimes(1);
      expect(seatStream.emit).toHaveBeenCalledWith({ sessionId: 'session-1' });
    });

    it('REFUND_FAILED (места держатся) и ределивери EXPIRED → без сигнала', async () => {
      bookingsRepo.update.mockResolvedValue({ affected: 1 });
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'CANCELLING',
      });

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'REFUND_FAILED',
        message: 'Банк отказал в возврате',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });
      expect(seatStream.emit).not.toHaveBeenCalled();

      // ределивери EXPIRED: условный UPDATE в транзакции уже никого не задел
      emUpdate.mockResolvedValue({ affected: 0 });
      await service.handleExpired({
        bookingId: 'booking-1',
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: '2026-09-03T12:15:00Z',
      });
      expect(seatStream.emit).not.toHaveBeenCalled();
    });
  });

});

/**
 * BookingsService (unit): сага отмены.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { buildBookingsHarness, type BookingsHarness, authUser, bookingFixture } from './bookings.service.harness';
import { BookingStatus, Booking } from './booking.entity';

describe('BookingsService: сага отмены (unit)', () => {
  let service: BookingsHarness['service'];
  let bookingsRepo: BookingsHarness['bookingsRepo'];
  let occupancyRepo: BookingsHarness['occupancyRepo'];
  let rabbit: BookingsHarness['rabbit'];

  beforeEach(async () => {
    ({ service, bookingsRepo, occupancyRepo, rabbit } = await buildBookingsHarness());
  });

  describe('cancel', () => {
    /** «строка БД»: условный UPDATE по статусу — как WHERE в реальном PG */
    let db: Booking;

    beforeEach(() => {
      db = { ...bookingFixture(), status: 'CONFIRMED' };
      bookingsRepo.findOneByOrFail.mockResolvedValue(db);
      bookingsRepo.update.mockImplementation(
        async (criteria: { status?: BookingStatus }, patch: Partial<Booking>) => {
          if (criteria.status && db.status !== criteria.status) {
            return { affected: 0 };
          }
          Object.assign(db, patch);
          return { affected: 1 };
        },
      );
    });

    it('переводит CONFIRMED-бронь в CANCELLING', async () => {
      const result = await service.cancel('booking-1', authUser);

      expect(result.status).toBe('CANCELLING');
      expect(bookingsRepo.update).toHaveBeenCalledWith(
        { id: 'booking-1', status: 'CONFIRMED' },
        { status: 'CANCELLING' },
      );
    });

    it('публикует booking.cancelled с суммой возврата и сеансом', async () => {
      await service.cancel('booking-1', authUser);

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'booking.cancelled',
        expect.objectContaining({
          bookingId: 'booking-1',
          movieTitle: 'Рекурсия',
          sessionId: 'session-1',
          hall: 'IMAX',
          seats: ['5-7', '5-8', '5-9'],
          totalRub: 1200,
        }),
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it('403: чужую бронь отменить нельзя', async () => {
      const promise = service.cancel('booking-1', {
        ...authUser,
        id: 'user-2',
        name: 'Гость',
      });

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      // сага не запускается — события и UPDATE не было
      expect(rabbit.publish).not.toHaveBeenCalled();
      expect(bookingsRepo.update).not.toHaveBeenCalled();
    });

    it('409 с текущим статусом, если статус не отменяемый', async () => {
      db.status = 'PENDING'; // платёж уже в полёте

      const promise = service.cancel('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ status: 'PENDING' });
      // сага не запущена — события нет
      expect(rabbit.publish).not.toHaveBeenCalled();
    });

    it('неоплаченную (PENDING_PAYMENT) закрывает сразу, без воркера', async () => {
      db.status = 'PENDING_PAYMENT';

      const result = await service.cancel('booking-1', authUser);

      expect(result.status).toBe('CANCELLED');
      expect(bookingsRepo.update).toHaveBeenCalledWith(
        { id: 'booking-1', status: 'PENDING_PAYMENT' },
        expect.objectContaining({ status: 'CANCELLED' }),
      );
      // возвращать нечего — события booking.cancelled нет; но места
      // освободились — лист ожидания должен об этом узнать
      expect(rabbit.publish).toHaveBeenCalledTimes(1);
      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'waitlist.seat.released',
        expect.objectContaining({
          sessionId: 'session-1',
          bookingId: 'booking-1',
          reason: 'CANCELLED_UNPAID',
        }),
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it('отмена неоплаченной освобождает места сразу', async () => {
      db.status = 'PENDING_PAYMENT';

      await service.cancel('booking-1', authUser);

      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
    });
  });

});

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
  let outboxInsert: BookingsHarness['outboxInsert'];
  let emUpdate: BookingsHarness['emUpdate'];

  beforeEach(async () => {
    ({ service, bookingsRepo, occupancyRepo, outboxInsert, emUpdate } = await buildBookingsHarness());
  });

  describe('cancel', () => {
    /** «строка БД»: условный UPDATE по статусу — как WHERE в реальном PG */
    let db: Booking;

    beforeEach(() => {
      db = { ...bookingFixture(), status: 'CONFIRMED' };
      bookingsRepo.findOneByOrFail.mockResolvedValue(db);
      emUpdate.mockImplementation(
        async (
          _entity: unknown,
          criteria: { status?: BookingStatus },
          patch: Partial<Booking>,
        ) => {
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
      expect(emUpdate).toHaveBeenCalledWith(
        Booking,
        { id: 'booking-1', status: 'CONFIRMED' },
        { status: 'CANCELLING' },
      );
    });

    it('пишет booking.cancelled в outbox — с суммой возврата и сеансом', async () => {
      await service.cancel('booking-1', authUser);

      expect(outboxInsert).toHaveBeenCalledTimes(1);
      const row = outboxInsert.mock.calls[0][0];
      expect(row.routingKey).toBe('booking.cancelled');
      expect(row.payload).toMatchObject({
        bookingId: 'booking-1',
        movieTitle: 'Рекурсия',
        sessionId: 'session-1',
        hall: 'IMAX',
        seats: ['5-7', '5-8', '5-9'],
        totalRub: 1200,
      });
    });

    it('403: чужую бронь отменить нельзя', async () => {
      const promise = service.cancel('booking-1', {
        ...authUser,
        id: 'user-2',
        name: 'Гость',
      });

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      // сага не запускается — события и UPDATE не было
      expect(outboxInsert).not.toHaveBeenCalled();
      expect(emUpdate).not.toHaveBeenCalled();
    });

    it('409 с текущим статусом, если статус не отменяемый', async () => {
      db.status = 'PENDING'; // платёж уже в полёте

      const promise = service.cancel('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ status: 'PENDING' });
      // сага не запущена — события нет
      expect(outboxInsert).not.toHaveBeenCalled();
    });

    it('неоплаченную (PENDING_PAYMENT) закрывает сразу, без воркера', async () => {
      db.status = 'PENDING_PAYMENT';

      const result = await service.cancel('booking-1', authUser);

      expect(result.status).toBe('CANCELLED');
      expect(emUpdate).toHaveBeenCalledWith(
        Booking,
        { id: 'booking-1', status: 'PENDING_PAYMENT' },
        expect.objectContaining({ status: 'CANCELLED' }),
      );
      // возвращать нечего — события booking.cancelled нет; но места
      // освободились — лист ожидания должен об этом узнать
      expect(outboxInsert).toHaveBeenCalledTimes(1);
      const row = outboxInsert.mock.calls[0][0];
      expect(row.routingKey).toBe('waitlist.seat.released');
      expect(row.payload).toMatchObject({
        sessionId: 'session-1',
        bookingId: 'booking-1',
        seats: ['5-7', '5-8', '5-9'],
        reason: 'CANCELLED_UNPAID',
      });
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

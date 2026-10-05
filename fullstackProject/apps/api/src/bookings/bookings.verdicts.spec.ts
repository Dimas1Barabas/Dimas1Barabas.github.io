/**
 * BookingsService (unit): вердикты воркера: handleProcessed/Expired/Refunded.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */

import { buildBookingsHarness, type BookingsHarness, sessionFixture, bookingFixture, flushAsync } from './bookings.service.harness';
import { Booking } from './booking.entity';

describe('BookingsService: вердикты воркера: handleProcessed/Expired/Refunded (unit)', () => {
  let service: BookingsHarness['service'];
  let bookingsRepo: BookingsHarness['bookingsRepo'];
  let sessionsRepo: BookingsHarness['sessionsRepo'];
  let occupancyRepo: BookingsHarness['occupancyRepo'];
  let reminders: BookingsHarness['reminders'];
  let rabbit: BookingsHarness['rabbit'];
  let stream: BookingsHarness['stream'];
  let emUpdate: BookingsHarness['emUpdate'];
  let bonusRows: BookingsHarness['bonusRows'];

  beforeEach(async () => {
    ({ service, bookingsRepo, sessionsRepo, occupancyRepo, reminders, rabbit, stream, bonusRows, emUpdate } = await buildBookingsHarness());
  });

  describe('handleProcessed', () => {
    it('применяет вердикт воркера и сохраняет', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(bookingsRepo.save).toHaveBeenCalledTimes(1);
      const saved = bookingsRepo.save.mock.calls[0][0] as Booking;
      expect(saved.status).toBe('CONFIRMED');
      expect(saved.message).toBe('Оплата прошла');
      expect(saved.processedBy).toBe('go-worker-1');
      expect(saved.processedAt).toEqual(new Date('2026-09-03T12:00:05Z'));
      // подтверждённая бронь держит места
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
    });

    it('FAILED — освобождает места брони', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'FAILED',
        message: 'Платёж отклонён',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
    });

    it('CONFIRMED публикует сигнал КиноСоветнику (dedup по bookingId)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'recommendation.booking.confirmed',
        {
          userId: 'user-1',
          movieId: 'movie-1',
          movieTitle: 'Рекурсия',
          genre: 'хоррор',
          bookingId: 'booking-1',
          occurredAt: expect.any(String),
        },
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it('гостевая CONFIRMED-бронь сигнал рекомендациям не публикует', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        userId: null,
      });

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(rabbit.publish).not.toHaveBeenCalledWith(
        'cinema',
        'recommendation.booking.confirmed',
        expect.anything(),
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    it('CONFIRMED с будущим сеансом планирует напоминание (email владельца)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
      // фикстурный сеанс давно прошёл — подменяем будущим
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
      });

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });
      await flushAsync();

      expect(reminders.schedule).toHaveBeenCalledWith({
        bookingId: 'booking-1',
        userId: 'user-1',
        email: 'dmitry@example.com',
        movieId: 'movie-1',
        movieTitle: 'Рекурсия',
        hall: 'IMAX',
        sessionAt: expect.any(String),
        seats: ['5-7', '5-8', '5-9'],
      });
    });

    it('сеанс уже прошёл — напоминание не планируется', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
      // фикстура: startsAt 2026-09-05 — в прошлом

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });
      await flushAsync();

      expect(reminders.schedule).not.toHaveBeenCalled();
    });

    it('недоступность reminder-сервиса не валит вердикт', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());
      sessionsRepo.findOneByOrFail.mockResolvedValue({
        ...sessionFixture,
        startsAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
      });
      reminders.schedule.mockRejectedValueOnce(new Error('UNAVAILABLE'));

      await expect(
        service.handleProcessed({
          bookingId: 'booking-1',
          status: 'CONFIRMED',
          message: 'Оплата прошла',
          processedBy: 'go-worker-1',
          processedAt: '2026-09-03T12:00:05Z',
        }),
      ).resolves.toBeUndefined();
      await flushAsync();

      expect(bookingsRepo.save).toHaveBeenCalledTimes(1);
    });

    it('пропускает вердикт по бронь не в PENDING (ределивери/EXPIRED)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'EXPIRED',
      });

      await service.handleProcessed({
        bookingId: 'booking-1',
        status: 'CONFIRMED',
        message: 'Оплата прошла',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      expect(bookingsRepo.save).not.toHaveBeenCalled();
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
      expect(stream.emit).not.toHaveBeenCalled();
    });

    describe('бонусный хвост вердикта', () => {
      const processed = (status: 'CONFIRMED' | 'FAILED') => ({
        bookingId: 'booking-1',
        status,
        message: status === 'CONFIRMED' ? 'Оплата прошла' : 'Платёж отклонён',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:00:05Z',
      });

      it('CONFIRMED начисляет кэшбэк: 5% от финальной суммы, floor', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          totalRub: 1080,
        });

        await service.handleProcessed(processed('CONFIRMED'));

        // floor(1080 × 5%) = 54 — от суммы после промокода и бонусов
        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'cashback',
          amount: 54,
        });
      });

      it('копеечная оплата — кэшбэк ноль, строки нет', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          totalRub: 19, // floor(0.95) = 0
        });

        await service.handleProcessed(processed('CONFIRMED'));

        expect(bonusRows).toHaveLength(0);
      });

      it('FAILED возвращает списанные при оплате бонусы', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          bonusSpent: 400,
        });

        await service.handleProcessed(processed('FAILED'));

        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'payment_failed',
          amount: 400,
        });
      });

      it('FAILED без списания — строки нет', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

        await service.handleProcessed(processed('FAILED'));

        expect(bonusRows).toHaveLength(0);
      });

      it('гостевая бронь (без владельца) кэшбэк не зарабатывает', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          userId: null,
        });

        await service.handleProcessed(processed('CONFIRMED'));

        expect(bonusRows).toHaveLength(0);
      });
    });
  });

  describe('handleExpired', () => {
    it('гасит ждущую оплаты бронь в EXPIRED и освобождает места', async () => {
      emUpdate.mockResolvedValue({ affected: 1 });
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

      // условный UPDATE и освобождение мест — в общей транзакции (em)
      expect(emUpdate).toHaveBeenCalledWith(
        Booking,
        { id: 'booking-1', status: 'PENDING_PAYMENT' },
        {
          status: 'EXPIRED',
          message: 'Время оплаты истекло',
          processedBy: 'go-worker-1',
          processedAt: new Date('2026-09-03T12:15:00Z'),
        },
      );
      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
      expect(stream.emit).toHaveBeenCalledTimes(1);
    });

    it('пропускает событие, если бронь уже не ждёт оплаты (pay-vs-timeout)', async () => {
      emUpdate.mockResolvedValue({ affected: 0 });

      await service.handleExpired({
        bookingId: 'booking-1',
        message: 'Время оплаты истекло',
        processedBy: 'go-worker-1',
        expiredAt: '2026-09-03T12:15:00Z',
      });

      expect(occupancyRepo.delete).not.toHaveBeenCalled();
      expect(stream.emit).not.toHaveBeenCalled();
    });
  });

  describe('handleRefunded', () => {
    function cancellingFixture(): Booking {
      return { ...bookingFixture(), status: 'CANCELLING' };
    }

    it('CANCELLED — закрывает сагу и освобождает места', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      const saved = bookingsRepo.save.mock.calls[0][0] as Booking;
      expect(saved.status).toBe('CANCELLED');
      expect(saved.message).toBe('Возврат 1200 ₽ зачислен');
      expect(occupancyRepo.delete).toHaveBeenCalledWith({
        bookingId: 'booking-1',
      });
    });

    it('CANCELLED — гасит напоминание брони', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });
      await flushAsync();

      expect(reminders.cancel).toHaveBeenCalledWith('booking-1');
    });

    it('REFUND_FAILED — напоминание продолжает ждать сеанса', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'REFUND_FAILED',
        message: 'Банк отклонил возврат',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });
      await flushAsync();

      expect(reminders.cancel).not.toHaveBeenCalled();
    });

    it('REFUND_FAILED — откатывает в CONFIRMED, места держит', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'REFUND_FAILED',
        message: 'Банк отклонил возврат',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      const saved = bookingsRepo.save.mock.calls[0][0] as Booking;
      expect(saved.status).toBe('CONFIRMED');
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
    });

    it('пропускает событие по бронь не в CANCELLING (ределивери)', async () => {
      bookingsRepo.findOneByOrFail.mockResolvedValue(bookingFixture());

      await service.handleRefunded({
        bookingId: 'booking-1',
        status: 'CANCELLED',
        message: 'Возврат 1200 ₽ зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      expect(bookingsRepo.save).not.toHaveBeenCalled();
      expect(occupancyRepo.delete).not.toHaveBeenCalled();
    });

    describe('разворот бонусов', () => {
      const refunded = (status: 'CANCELLED' | 'REFUND_FAILED') => ({
        bookingId: 'booking-1',
        status,
        message: 'Возврат зачислен',
        processedBy: 'go-worker-1',
        processedAt: '2026-09-03T12:05:00Z',
      });

      it('CANCELLED: списанное вернулось, кэшбэк погасился', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());
        // бронь оплачена с 400 бонусами, кэшбэк по ней — 54
        bonusRows.push(
          {
            userId: 'user-1',
            bookingId: 'booking-1',
            kind: 'spend',
            reason: 'payment',
            amount: 400,
          },
          {
            userId: 'user-1',
            bookingId: 'booking-1',
            kind: 'accrual',
            reason: 'cashback',
            amount: 54,
          },
        );

        await service.handleRefunded(refunded('CANCELLED'));

        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'refund',
          amount: 400,
        });
        // баланс к моменту гашения: −400 + 54 + 400 = 54 → весь кэшбэк
        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'spend',
          reason: 'clawback',
          amount: 54,
        });
      });

      it('кэшбэк уже потрачен — гасим сколько есть, не в минус', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());
        // кэшбэк 100 по этой брони, 60 из него потрачено на другой —
        // баланс 40, гасим только его
        bonusRows.push(
          {
            userId: 'user-1',
            bookingId: 'booking-1',
            kind: 'accrual',
            reason: 'cashback',
            amount: 100,
          },
          {
            userId: 'user-1',
            bookingId: 'other-booking',
            kind: 'spend',
            reason: 'payment',
            amount: 60,
          },
        );

        await service.handleRefunded(refunded('CANCELLED'));

        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'spend',
          reason: 'clawback',
          amount: 40,
        });
        // списания при оплате этой брони не было — refund-строки нет
        expect(
          bonusRows.filter((r) => r.reason === 'refund'),
        ).toHaveLength(0);
      });

      it('REFUND_FAILED — бронь живёт дальше, бонусы не тронуты', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue(cancellingFixture());
        bonusRows.push({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'accrual',
          reason: 'cashback',
          amount: 54,
        });

        await service.handleRefunded(refunded('REFUND_FAILED'));

        expect(bonusRows).toHaveLength(1);
      });
    });
  });

});

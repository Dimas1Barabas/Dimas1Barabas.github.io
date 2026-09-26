/**
 * BookingsService (unit): оплата: pay и промокоды.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */
import { ConflictException, ForbiddenException, GoneException, NotFoundException } from '@nestjs/common';
import { buildBookingsHarness, type BookingsHarness, authUser, bookingFixture } from './bookings.service.harness';
import { Booking } from './booking.entity';

describe('BookingsService: оплата: pay и промокоды (unit)', () => {
  let service: BookingsHarness['service'];
  let bookingsRepo: BookingsHarness['bookingsRepo'];
  let promosRepo: BookingsHarness['promosRepo'];
  let rabbit: BookingsHarness['rabbit'];
  let stream: BookingsHarness['stream'];
  let emUpdate: BookingsHarness['emUpdate'];
  let emQuery: BookingsHarness['emQuery'];
  let bonusRows: BookingsHarness['bonusRows'];

  beforeEach(async () => {
    ({ service, bookingsRepo, promosRepo, rabbit, stream, emUpdate, emQuery, bonusRows } = await buildBookingsHarness());
  });

  describe('pay', () => {
    beforeEach(() => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });
    });

    it('переводит PENDING_PAYMENT → PENDING условным UPDATE', async () => {
      const result = await service.pay('booking-1', authUser);

      expect(result.status).toBe('PENDING');
      expect(emUpdate).toHaveBeenCalledWith(
        Booking,
        { id: 'booking-1', status: 'PENDING_PAYMENT' },
        { status: 'PENDING' },
      );
    });

    it('публикует booking.created — воркер начинает проводить платёж', async () => {
      await service.pay('booking-1', authUser);

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.objectContaining({
          bookingId: 'booking-1',
          movieTitle: 'Рекурсия',
          sessionId: 'session-1',
          hall: 'IMAX',
          seats: ['5-7', '5-8', '5-9'],
          totalRub: 1200,
        }),
      );
      expect(stream.emit).toHaveBeenCalledTimes(1);
    });

    it('409 с текущим статусом, если бронь уже не ждёт оплаты', async () => {
      emUpdate.mockResolvedValue({ affected: 0 });

      const promise = service.pay('booking-1', authUser);

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({ status: 'PENDING_PAYMENT' });
      expect(rabbit.publish).not.toHaveBeenCalled();
    });

    it('403: чужую бронь оплатить нельзя', async () => {
      const promise = service.pay('booking-1', {
        ...authUser,
        id: 'user-2',
        name: 'Гость',
      });

      await expect(promise).rejects.toBeInstanceOf(ForbiddenException);
      expect(emUpdate).not.toHaveBeenCalled();
      expect(rabbit.publish).not.toHaveBeenCalled();
    });
  });

  describe('pay с промокодом', () => {
    beforeEach(() => {
      bookingsRepo.findOneByOrFail.mockResolvedValue({
        ...bookingFixture(),
        status: 'PENDING_PAYMENT',
      });
    });

    it('применяет промокод: скидка в totalRub, код и сумма — на брони', async () => {
      emQuery.mockResolvedValue([
        [{ code: 'CINE10', kind: 'percent', value: 10 }],
        1,
      ]);

      const result = await service.pay('booking-1', authUser, 'cine10');

      // 1200 − 10% = 1080
      expect(result).toMatchObject({
        status: 'PENDING',
        totalRub: 1080,
        promoCode: 'CINE10',
        discountRub: 120,
      });
      expect(emUpdate).toHaveBeenCalledTimes(2);
      expect(emUpdate).toHaveBeenLastCalledWith(
        Booking,
        { id: 'booking-1' },
        { totalRub: 1080, promoCode: 'CINE10', discountRub: 120 },
      );
    });

    it('воркеру уходит событие со скидочной суммой', async () => {
      emQuery.mockResolvedValue([
        [{ code: 'CINE10', kind: 'percent', value: 10 }],
        1,
      ]);

      await service.pay('booking-1', authUser, 'CINE10');

      expect(rabbit.publish).toHaveBeenCalledWith(
        'cinema',
        'booking.created',
        expect.objectContaining({ totalRub: 1080 }),
      );
    });

    it('гонка за последний код: активация не прошла → 409 promoExhausted, оплата откатилась', async () => {
      emQuery.mockResolvedValue([[], 0]);
      promosRepo.findOneBy.mockResolvedValue({
        id: 'promo-1',
        code: 'CINE10',
        kind: 'percent',
        value: 10,
        maxActivations: 3,
        usedCount: 3,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const promise = service.pay('booking-1', authUser, 'CINE10');

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getResponse()).toMatchObject({ code: 'promoExhausted' });
      // скидка не писалась и событие воркеру не ушло — транзакция откатилась
      expect(emUpdate).toHaveBeenCalledTimes(1);
      expect(rabbit.publish).not.toHaveBeenCalled();
    });

    it('неизвестный код → 404 promoNotFound', async () => {
      emQuery.mockResolvedValue([[], 0]);
      promosRepo.findOneBy.mockResolvedValue(null);

      const promise = service.pay('booking-1', authUser, 'NOPE');

      await expect(promise).rejects.toBeInstanceOf(NotFoundException);
      const err = (await promise.catch((e: unknown) => e)) as NotFoundException;
      expect(err.getResponse()).toMatchObject({ code: 'promoNotFound' });
    });

    it('просроченный код → 410 promoExpired', async () => {
      emQuery.mockResolvedValue([[], 0]);
      promosRepo.findOneBy.mockResolvedValue({
        id: 'promo-1',
        code: 'OLD10',
        kind: 'percent',
        value: 10,
        maxActivations: 100,
        usedCount: 0,
        expiresAt: new Date(Date.now() - 1000),
      });

      const promise = service.pay('booking-1', authUser, 'OLD10');

      await expect(promise).rejects.toBeInstanceOf(GoneException);
      const err = (await promise.catch((e: unknown) => e)) as GoneException;
      expect(err.getResponse()).toMatchObject({ code: 'promoExpired' });
    });

    describe('списание бонусов', () => {
      /** сидим на счёт 500 бонусов (кэшбэк прошлой брони) */
      const seedBalance = (amount = 500) => {
        bonusRows.push({
          userId: 'user-1',
          bookingId: 'seed-booking',
          kind: 'accrual',
          reason: 'cashback',
          amount,
        });
      };

      it('списывает бонусы в пределах лимита: spend-строка в ledger, итог меньше', async () => {
        seedBalance(500);

        const result = await service.pay('booking-1', authUser, undefined, 400);

        // 1200 − 400 бонусов = 800
        expect(result).toMatchObject({
          status: 'PENDING',
          totalRub: 800,
          bonusSpent: 400,
        });
        expect(bonusRows).toContainEqual({
          userId: 'user-1',
          bookingId: 'booking-1',
          kind: 'spend',
          reason: 'payment',
          amount: 400,
        });
        expect(emUpdate).toHaveBeenLastCalledWith(
          Booking,
          { id: 'booking-1' },
          { totalRub: 800, bonusSpent: 400 },
        );
        expect(rabbit.publish).toHaveBeenCalledWith(
          'cinema',
          'booking.created',
          expect.objectContaining({ totalRub: 800 }),
        );
      });

      it('промокод и бонусы вместе: скидка первой, лимит — от остатка', async () => {
        seedBalance(600);
        emQuery.mockImplementation(async (sql: string, params: unknown[]) => {
          if (/UPDATE promos/.test(sql)) {
            return [[{ code: 'CINE10', kind: 'percent', value: 10 }], 1];
          }
          if (/user_id/.test(sql)) {
            const balance = bonusRows
              .filter((r) => r.userId === params[0])
              .reduce(
                (s, r) => s + (r.kind === 'accrual' ? r.amount : -r.amount),
                0,
              );
            return [{ balance: String(balance) }];
          }
          return [[], 0];
        });

        // 1200 −10% = 1080; половина остатка = 540 — граница проходит
        const result = await service.pay(
          'booking-1',
          authUser,
          'CINE10',
          540,
        );

        expect(result).toMatchObject({
          totalRub: 540,
          discountRub: 120,
          bonusSpent: 540,
        });
      });

      it('409 bonusOverLimit: больше половины чека, оплата откатилась', async () => {
        seedBalance(5000);

        // лимит = 600, просим 700
        const promise = service.pay('booking-1', authUser, undefined, 700);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusOverLimit' });
        // только переключение статуса — скидки/списания не писались
        expect(emUpdate).toHaveBeenCalledTimes(1);
        expect(bonusRows).toHaveLength(1); // только сид
        expect(rabbit.publish).not.toHaveBeenCalled();
      });

      it('409 bonusInsufficient: баланса меньше запрошенного', async () => {
        seedBalance(100);

        const promise = service.pay('booking-1', authUser, undefined, 200);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusInsufficient' });
        expect(bonusRows).toHaveLength(1);
      });

      it('гонка балансом: контрольный пересчёт ушёл в минус → 409, всё откатилось', async () => {
        seedBalance(300);
        let balanceCalls = 0;
        emQuery.mockImplementation(async (sql: string) => {
          if (/user_id/.test(sql)) {
            balanceCalls += 1;
            // первая проверка видит 300; после вставки «параллельная оплата»
            // успела списать 500 — контрольный пересчёт уходит в минус
            return [{ balance: balanceCalls === 1 ? '300' : '-200' }];
          }
          return [[], 0];
        });

        const promise = service.pay('booking-1', authUser, undefined, 200);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusInsufficient' });
        expect(rabbit.publish).not.toHaveBeenCalled();
      });

      it('409 bonusUnavailable: гостевая бронь без владельца', async () => {
        bookingsRepo.findOneByOrFail.mockResolvedValue({
          ...bookingFixture(),
          userId: null,
          status: 'PENDING_PAYMENT',
        });

        const promise = service.pay('booking-1', authUser, undefined, 100);

        await expect(promise).rejects.toBeInstanceOf(ConflictException);
        const err =
          (await promise.catch((e: unknown) => e)) as ConflictException;
        expect(err.getResponse()).toMatchObject({ code: 'bonusUnavailable' });
      });
    });
  });

});

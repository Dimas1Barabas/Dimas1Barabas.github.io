/**
 * BookingsService (unit): создание брони и цена сеанса.
 * Общий харнесс — фикстуры и фейки репозиториев/шин — в
 * ./bookings.service.harness; каждый домен деструктурирует нужное.
 */
import { ConflictException } from '@nestjs/common';
import { SeatOccupancy } from './seat-occupancy.entity';
import { buildBookingsHarness, type BookingsHarness, sessionFixture, authUser } from './bookings.service.harness';
import { CreateBookingDto } from './dto/create-booking.dto';

describe('BookingsService: создание брони и цена сеанса (unit)', () => {
  let service: BookingsHarness['service'];
  let moviesRepo: BookingsHarness['moviesRepo'];
  let sessionsRepo: BookingsHarness['sessionsRepo'];
  let occupancyRepo: BookingsHarness['occupancyRepo'];
  let waitlistRepo: BookingsHarness['waitlistRepo'];
  let pricing: BookingsHarness['pricing'];
  let rabbit: BookingsHarness['rabbit'];
  let emInsert: BookingsHarness['emInsert'];

  beforeEach(async () => {
    ({ service, moviesRepo, sessionsRepo, occupancyRepo, waitlistRepo, pricing, rabbit, emInsert } = await buildBookingsHarness());
  });

  describe('create', () => {
    it('сохраняет PENDING_PAYMENT-бронь с дедлайном оплаты и суммой', async () => {
      const dto: CreateBookingDto = {
        sessionId: 'session-1',
        customerName: 'Дмитрий',
        seats: ['5-7', '5-8', '5-9'],
      };

      const result = await service.create(dto, authUser);

      expect(result.status).toBe('PENDING_PAYMENT');
      // дедлайн — стандартное окно оплаты (15 мин) от создания
      expect(result.expiresAt).toBeTruthy();
      const skewMs = Math.abs(
        Date.parse(result.expiresAt!) - Date.now() - 15 * 60_000,
      );
      expect(skewMs).toBeLessThan(60_000);
      expect(result.totalRub).toBe(1200); // 400 × 3
      expect(result.movieTitle).toBe('Рекурсия');
      expect(result.sessionId).toBe('session-1');
      expect(result.hall).toBe('IMAX');
      expect(result.sessionAt).toBe('2026-09-05T19:00:00.000Z');
      expect(result.seats).toEqual(['5-7', '5-8', '5-9']);
    });

    it('гасит запись в листе ожидания этого сеанса — create → LEFT', async () => {
      const dto: CreateBookingDto = {
        sessionId: 'session-1',
        customerName: 'Дмитрий',
        seats: ['5-7'],
      };

      await service.create(dto, authUser);

      expect(waitlistRepo.update).toHaveBeenCalledWith(
        { sessionId: 'session-1', userId: authUser.id },
        { status: 'LEFT' },
      );
    });

    it('фильм выводит из сеанса — бронь привязана к обоим', async () => {
      await service.create(
        { sessionId: 'session-1', seats: ['1-1'] },
        authUser,
      );

      expect(sessionsRepo.findOneByOrFail).toHaveBeenCalledWith({
        id: 'session-1',
      });
      expect(moviesRepo.findOneByOrFail).toHaveBeenCalledWith({
        id: 'movie-1', // movieId взят из сеанса
      });
    });

    it('имя покупателя берёт из JWT, если customerName не передан', async () => {
      const result = await service.create(
        { sessionId: 'session-1', seats: ['1-1'] },
        authUser,
      );

      expect(result.customerName).toBe('Дмитрий');
      expect(result.userId).toBe('user-1');
    });

    it('занимает места строками занятости сеанса в той же транзакции', async () => {
      await service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['5-7'],
        },
        authUser,
      );

      expect(emInsert).toHaveBeenCalledWith(
        SeatOccupancy,
        expect.arrayContaining([
          expect.objectContaining({ sessionId: 'session-1', seat: '5-7' }),
        ]),
      );
    });

    it('публикует booking.payment.wait — запускает таймер резерва', async () => {
      const result = await service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['5-7', '5-8', '5-9'],
        },
        authUser,
      );

      expect(rabbit.publish).toHaveBeenCalledTimes(1);
      const [exchange, routingKey, event] = rabbit.publish.mock.calls[0];
      expect(exchange).toBe('cinema');
      expect(routingKey).toBe('booking.payment.wait');
      expect(event).toMatchObject({
        bookingId: result.id,
        totalRub: 1200,
        expiresAt: result.expiresAt,
      });
    });

    it('цена брони — от Тарификатора: квот с факторами до транзакции', async () => {
      pricing.quote.mockResolvedValueOnce({
        priceRub: 480, // вечер +20%
        basePriceRub: 400,
        factors: [{ code: 'evening', label: 'вечерний прайм +20%', percent: 20 }],
        occupied: 12,
        capacity: 80,
      });

      const result = await service.create(
        { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['5-7', '5-8'] },
        authUser,
      );

      expect(pricing.quote).toHaveBeenCalledWith({
        sessionId: 'session-1',
        sessionAt: sessionFixture.startsAt.toISOString(),
        basePriceRub: 400,
        capacity: 80,
      });
      expect(result.totalRub).toBe(960); // 480 × 2
      // спрос Тарификатора: wait-событие несёт сеанс и число мест
      const event = rabbit.publish.mock.calls[0][2];
      expect(event).toMatchObject({ sessionId: 'session-1', seatsCount: 2 });
    });

    it('недоступность Тарификатора — базовая цена, бронь жива', async () => {
      pricing.quote.mockRejectedValueOnce(new Error('deadline exceeded'));

      const result = await service.create(
        { sessionId: 'session-1', customerName: 'Дмитрий', seats: ['5-7'] },
        authUser,
      );

      expect(result.totalRub).toBe(400); // база афиши × 1 место
      expect(result.status).toBe('PENDING_PAYMENT');
    });

    it('мусор в ответе Тарификатора — тоже базовая цена', async () => {
      pricing.quote.mockResolvedValueOnce({ priceRub: -50 });

      const result = await service.create(
        { sessionId: 'session-1', seats: ['5-7'] },
        authUser,
      );

      expect(result.totalRub).toBe(400);
    });

    it('обрезает пробелы вокруг имени', async () => {
      const result = await service.create(
        {
          sessionId: 'session-1',
          customerName: '  Дмитрий  ',
          seats: ['1-1'],
        },
        authUser,
      );
      expect(result.customerName).toBe('Дмитрий');
    });

    it('409 со списком мест, если констрейнт отбил вставку', async () => {
      // имитируем pg: уникальный констрейнт (session_id, seat)
      emInsert.mockRejectedValue({ code: '23505' });
      occupancyRepo.find.mockResolvedValue([
        { seat: '5-7', sessionId: 'session-1' },
        { seat: '5-8', sessionId: 'session-1' },
      ]);

      const promise = service.create(
        {
          sessionId: 'session-1',
          customerName: 'Дмитрий',
          seats: ['5-8', '5-7', '6-1'],
        },
        authUser,
      );

      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const err = (await promise.catch((e: unknown) => e)) as ConflictException;
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        seatsTaken: ['5-7', '5-8'],
      });
      // конфликт искали среди мест именно этого сеанса
      expect(occupancyRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ sessionId: 'session-1' }),
        }),
      );
      // событие в очередь не ушло
      expect(rabbit.publish).not.toHaveBeenCalled();
    });
  });

  describe('sessionPrice', () => {
    it('витрина цены: факторы и dynamic=true, когда Тарификатор ответил', async () => {
      pricing.quote.mockResolvedValueOnce({
        priceRub: 550,
        basePriceRub: 400,
        factors: [
          { code: 'evening', label: 'вечерний прайм +20%', percent: 20 },
          { code: 'demand_high', label: 'спрос высокий +10%', percent: 10 },
        ],
        occupied: 45,
        capacity: 80,
      });

      const dto = await service.sessionPrice('session-1');

      expect(dto).toMatchObject({
        sessionId: 'session-1',
        sessionAt: sessionFixture.startsAt.toISOString(),
        basePriceRub: 400,
        priceRub: 550,
        dynamic: true,
      });
      expect(dto.factors).toHaveLength(2);
    });

    it('недоступность Тарификатора — dynamic=false и базовая цена', async () => {
      pricing.quote.mockRejectedValueOnce(new Error('unavailable'));

      const dto = await service.sessionPrice('session-1');

      expect(dto).toMatchObject({
        priceRub: 400,
        basePriceRub: 400,
        dynamic: false,
      });
      expect(dto.factors).toEqual([]);
    });
  });

});

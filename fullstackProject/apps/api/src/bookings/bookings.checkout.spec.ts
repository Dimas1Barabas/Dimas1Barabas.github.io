/**
 * BookingsService (unit): мгновенный чекаут — композиция create + pay
 * за флагом checkout.new_flow. Хап-кейсы самих шагов живут в
 * bookings.create/pay-спеках; здесь — только склейка: одна цепочка
 * событий и поведение при отказе оплаты (бронь не прячется).
 */
import { ConflictException } from '@nestjs/common';
import {
  buildBookingsHarness,
  type BookingsHarness,
  authUser,
  bookingFixture,
} from './bookings.service.harness';

describe('BookingsService: мгновенный чекаут (unit)', () => {
  let service: BookingsHarness['service'];
  let bookingsRepo: BookingsHarness['bookingsRepo'];
  let promosRepo: BookingsHarness['promosRepo'];
  let outboxInsert: BookingsHarness['outboxInsert'];
  let emInsert: BookingsHarness['emInsert'];
  let emUpdate: BookingsHarness['emUpdate'];

  beforeEach(async () => {
    ({ service, bookingsRepo, promosRepo, outboxInsert, emInsert, emUpdate } =
      await buildBookingsHarness());
    // pay() перечитывает бронь, созданную этим же вызовом, — эхо по id:
    // места и сумма как у созданной (1 место × 400 ₽ базовой цены)
    bookingsRepo.findOneByOrFail.mockImplementation(
      async (where: { id: string }) => ({
        ...bookingFixture(),
        id: where.id,
        userId: authUser.id,
        seats: ['5-7'],
        totalRub: 400,
        status: 'PENDING_PAYMENT',
      }),
    );
  });

  it('бронь и оплата одной цепочкой: PENDING, воркеру ушло booking.created', async () => {
    const result = await service.checkout(
      { sessionId: 'session-1', seats: ['5-7'] },
      authUser,
    );

    expect(result.status).toBe('PENDING');
    // create занял место и завёл таймер резерва, pay запустила платёж —
    // обе записи outbox из одного клиентского вызова
    const keys = outboxInsert.mock.calls.map(
      (call: unknown[]) => (call[0] as { routingKey: string }).routingKey,
    );
    expect(keys).toEqual(['booking.payment.wait', 'booking.created']);
    // переключение статуса — то же условие, что у отдельной оплаты
    expect(emUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'PENDING_PAYMENT' }),
      { status: 'PENDING' },
    );
  });

  it('промокод исчерпан: 409 летит клиенту, бронь создана и ждёт оплаты', async () => {
    // активация не прошла (0 затронутых), причина — исчерпанный лимит
    promosRepo.findOneBy.mockResolvedValue({
      code: 'DEAD10',
      kind: 'percent',
      value: 10,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });

    const promise = service.checkout(
      { sessionId: 'session-1', seats: ['5-7'], promoCode: 'DEAD10' },
      authUser,
    );

    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    const err = (await promise.catch((e: unknown) => e)) as ConflictException;
    expect(err.getResponse()).toMatchObject({ code: 'promoExhausted' });
    // бронь успела родиться: места заняты, таймер резерва заведён —
    // платежа (booking.created) нет
    expect(emInsert).toHaveBeenCalledTimes(1);
    const keys = outboxInsert.mock.calls.map(
      (call: unknown[]) => (call[0] as { routingKey: string }).routingKey,
    );
    expect(keys).toEqual(['booking.payment.wait']);
  });
});

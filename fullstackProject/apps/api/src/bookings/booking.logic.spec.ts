import { Booking } from './booking.entity';
import { applyProcessed, computeTotal } from './booking.logic';

describe('computeTotal', () => {
  it.each([
    [450, 1, 450],
    [450, 3, 1350],
    [250, 8, 2000],
    [320, 0, 0],
  ])('цена %d × места %d = %d', (price, seats, expected) => {
    expect(computeTotal(price, seats)).toBe(expected);
  });
});

describe('applyProcessed', () => {
  const event = {
    bookingId: 'b-1',
    status: 'CONFIRMED' as const,
    message: 'Оплата прошла',
    processedBy: 'go-worker-1',
    processedAt: '2026-09-03T12:00:00.000Z',
  };

  it('обновляет статус, сообщение и метаданные обработки', () => {
    const booking = {
      status: 'PENDING',
      message: null,
      processedBy: null,
      processedAt: null,
    } as Booking;

    const result = applyProcessed(booking, event);

    expect(result.status).toBe('CONFIRMED');
    expect(result.message).toBe('Оплата прошла');
    expect(result.processedBy).toBe('go-worker-1');
    expect(result.processedAt).toEqual(new Date('2026-09-03T12:00:00.000Z'));
  });

  it('не трогает остальные поля брони', () => {
    const booking = {
      id: 'b-1',
      customerName: 'Аноним',
      seats: 2,
      totalRub: 900,
      status: 'PENDING',
    } as Booking;

    const result = applyProcessed(booking, event);

    expect(result.customerName).toBe('Аноним');
    expect(result.seats).toBe(2);
    expect(result.totalRub).toBe(900);
  });
});

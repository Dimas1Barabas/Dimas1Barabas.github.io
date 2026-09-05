import { BadRequestException } from '@nestjs/common';
import { Booking } from './booking.entity';
import {
  applyProcessed,
  applyRefunded,
  computeTotal,
  normalizeSeats,
} from './booking.logic';

describe('computeTotal', () => {
  it.each([
    [450, ['5-1'], 450],
    [450, ['5-1', '5-2', '5-3'], 1350],
    [250, Array.from({ length: 8 }, (_, i) => `1-${i + 1}`), 2000],
    [320, [], 0],
  ])('цена %d × %d мест = %d', (price, seats, expected) => {
    expect(computeTotal(price, seats)).toBe(expected);
  });
});

describe('normalizeSeats', () => {
  it('убирает дубли и сортирует по ряду, затем по месту', () => {
    expect(normalizeSeats(['2-10', '3-1', '2-9', '3-1'])).toEqual([
      '2-9',
      '2-10',
      '3-1',
    ]);
  });

  it.each([
    ['не «ряд-место»', ['5']],
    ['ряд вне зала', ['9-1']],
    ['место вне ряда', ['1-11']],
    ['ноль', ['0-1']],
    ['отрицательное', ['-1-2']],
  ])('400 на неверный код: %s', (_case, seats) => {
    expect(() => normalizeSeats(seats)).toThrow(BadRequestException);
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
      seats: ['5-7', '5-8'],
      totalRub: 900,
      status: 'PENDING',
    } as Booking;

    const result = applyProcessed(booking, event);

    expect(result.customerName).toBe('Аноним');
    expect(result.seats).toEqual(['5-7', '5-8']);
    expect(result.totalRub).toBe(900);
  });
});

describe('applyRefunded', () => {
  const base = {
    bookingId: 'b-1',
    message: 'Возврат выполнен',
    processedBy: 'go-worker-1',
    processedAt: '2026-09-03T12:05:00.000Z',
  };

  function cancelling(): Booking {
    return {
      status: 'CANCELLING',
      message: null,
      processedBy: null,
      processedAt: null,
    } as Booking;
  }

  it('успех закрывает сагу: CANCELLED + метаданные возврата', () => {
    const result = applyRefunded(cancelling(), {
      ...base,
      status: 'CANCELLED',
    });

    expect(result.status).toBe('CANCELLED');
    expect(result.message).toBe('Возврат выполнен');
    expect(result.processedBy).toBe('go-worker-1');
    expect(result.processedAt).toEqual(new Date('2026-09-03T12:05:00.000Z'));
  });

  it('отказ откатывает сагу назад в CONFIRMED', () => {
    const result = applyRefunded(cancelling(), {
      ...base,
      status: 'REFUND_FAILED',
      message: 'Банк отклонил возврат',
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.message).toBe('Банк отклонил возврат');
  });
});

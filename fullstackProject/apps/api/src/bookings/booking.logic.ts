import { BadRequestException } from '@nestjs/common';
import { Booking } from './booking.entity';
import { BookingProcessedEvent } from './booking-events';
import { compareSeats, isValidSeat } from './hall';

/** Стоимость брони: цена сеанса × число мест */
export function computeTotal(priceRub: number, seats: string[]): number {
  return priceRub * seats.length;
}

/**
 * Приводит места к каноническому виду: без дублей, отсортировано по залу.
 * Невалидный код места (не «ряд-место» или вне зала) — 400.
 */
export function normalizeSeats(seats: string[]): string[] {
  const unique = [...new Set(seats)];
  const invalid = unique.filter((s) => !isValidSeat(s));
  if (invalid.length > 0) {
    throw new BadRequestException(
      `Некорректные места: ${invalid.join(', ')} (формат — «ряд-место», зал 8×10)`,
    );
  }
  return unique.sort(compareSeats);
}

/** Применяет результат обработки от Go-воркера к брони */
export function applyProcessed(
  booking: Booking,
  event: BookingProcessedEvent,
): Booking {
  booking.status = event.status;
  booking.message = event.message;
  booking.processedBy = event.processedBy;
  booking.processedAt = new Date(event.processedAt);
  return booking;
}

import { Booking } from './booking.entity';
import { BookingProcessedEvent } from './booking-events';

/** Стоимость брони: цена сеанса × число мест */
export function computeTotal(priceRub: number, seats: number): number {
  return priceRub * seats;
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

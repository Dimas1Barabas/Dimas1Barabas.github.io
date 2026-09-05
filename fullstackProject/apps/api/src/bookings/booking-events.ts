/** Контракты сообщений RabbitMQ (обмен «cinema», topic) */

/** API → Go-воркер: routing key «booking.created» */
export interface BookingCreatedEvent {
  bookingId: string;
  movieId: string;
  movieTitle: string;
  customerName: string;
  /** коды мест «ряд-место», например ["5-7", "5-8"] */
  seats: string[];
  totalRub: number;
  createdAt: string;
}

/** Go-воркер → API: routing key «booking.processed» */
export interface BookingProcessedEvent {
  bookingId: string;
  status: 'CONFIRMED' | 'FAILED';
  message: string;
  processedBy: string;
  processedAt: string;
}

/** API → Go-воркер: routing key «booking.cancelled» — просит вернуть платёж */
export interface BookingCancelledEvent {
  bookingId: string;
  movieId: string;
  movieTitle: string;
  customerName: string;
  seats: string[];
  totalRub: number;
  cancelledAt: string;
}

/**
 * Go-воркер → API: routing key «booking.refunded» — вердикт по возврату.
 * REFUND_FAILED откатывает сагу: бронь возвращается в CONFIRMED.
 */
export interface BookingRefundedEvent {
  bookingId: string;
  status: 'CANCELLED' | 'REFUND_FAILED';
  message: string;
  processedBy: string;
  processedAt: string;
}

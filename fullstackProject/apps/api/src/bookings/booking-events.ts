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

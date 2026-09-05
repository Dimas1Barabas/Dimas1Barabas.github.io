export interface Movie {
  id: string;
  title: string;
  description: string;
  genre: string;
  genreIcon: string;
  durationMin: number;
  priceRub: number;
  /** оттенок градиентного постера (HSL hue) */
  hue: number;
  sessionAt: string;
}

export type BookingStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED';

/** карта занятости зала сеанса — GET /api/movies/:id/seats */
export interface SeatMap {
  movieId: string;
  layout: { rows: number; seatsPerRow: number };
  /** коды занятых мест «ряд-место» */
  occupied: string[];
  free: number;
}

export interface Booking {
  id: string;
  movieId: string;
  movieTitle: string;
  movieHue: number;
  movieGenreIcon: string;
  customerName: string;
  /** коды мест «ряд-место», например ["5-7", "5-8"] */
  seats: string[];
  totalRub: number;
  status: BookingStatus;
  message: string | null;
  processedBy: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface BookingStats {
  PENDING: number;
  CONFIRMED: number;
  FAILED: number;
  CANCELLING: number;
  CANCELLED: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: Record<string, 'up' | 'down'>;
  uptimeSec: number;
  timestamp: string;
}

export interface CreateBookingPayload {
  movieId: string;
  customerName: string;
  seats: string[];
}

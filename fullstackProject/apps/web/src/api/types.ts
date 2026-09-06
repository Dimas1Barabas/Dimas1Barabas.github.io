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

/** событие SSE «booking» из /bookings/stream: изменённая бронь + статистика */
export interface BookingStreamPayload {
  booking: Booking;
  stats: BookingStats;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: Record<string, 'up' | 'down'>;
  uptimeSec: number;
  timestamp: string;
}

export interface CreateBookingPayload {
  movieId: string;
  /** в live-режиме не передаём — имя берёт из JWT на бэкенде */
  customerName?: string;
  seats: string[];
}

export type UserRole = 'user' | 'admin';

/** UserDto из POST /auth/register */
export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
}

/** ответ POST /auth/login */
export interface LoginResult {
  accessToken: string;
  user: User;
}

export interface RegisterPayload {
  email: string;
  password: string;
  name: string;
}

/** новый сеанс в афишу — POST /api/movies (только админ) */
export interface CreateMoviePayload {
  title: string;
  description: string;
  genre: string;
  genreIcon: string;
  durationMin: number;
  priceRub: number;
  hue: number;
  /** ISO-дата сеанса */
  sessionAt: string;
}

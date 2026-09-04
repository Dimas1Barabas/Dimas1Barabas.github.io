import type {
  Booking,
  BookingStats,
  CreateBookingPayload,
  HealthResponse,
  Movie,
  SeatMap,
} from './types';

/** Базовый URL API. По умолчанию — тот же origin (vite-proxy / nginx) */
const BASE: string = import.meta.env.VITE_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 6000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError(`HTTP ${res.status}`, res.status, body);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: () => request<HealthResponse>('/health', undefined, 3500),
  movies: () =>
    request<{ source: 'cache' | 'db'; data: Movie[] }>('/movies'),
  bookings: () => request<Booking[]>('/bookings'),
  stats: () => request<BookingStats>('/bookings/stats'),
  /** карта занятости зала сеанса (без кэша — всегда свежая) */
  seatMap: (movieId: string) => request<SeatMap>(`/movies/${movieId}/seats`),
  createBooking: (payload: CreateBookingPayload) =>
    request<Booking>('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};

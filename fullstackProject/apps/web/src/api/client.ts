import type {
  AdminStatsEnvelope,
  Booking,
  BookingStats,
  CreateBookingPayload,
  CreateMoviePayload,
  CreateReviewPayload,
  HealthResponse,
  LoginResult,
  Movie,
  RegisterPayload,
  Review,
  SeatMap,
  User,
} from './types';

/** Базовый URL API. По умолчанию — тот же origin (vite-proxy / nginx) */
const BASE: string = import.meta.env.VITE_API_URL ?? '/api';

/** ключи localStorage для сессии (токен + пользователь) */
const TOKEN_KEY = 'cine.token';
const USER_KEY = 'cine.user';

/** полный URL эндпоинта — для EventSource, которому нужен обычный путь */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** сохранённый accessToken (после login) или null */
export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** сохранённый пользователь сессии или null */
export function storedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

/** токен и пользователь после успешного login */
export function saveAuth(token: string, user: User): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** выход: стираем сессию */
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 6000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = storedToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ApiError(`HTTP ${res.status}`, res.status, body);
    }
    // 204 (удаление) приходит без тела — res.json() на нём падает
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
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
  /** личный кабинет: свои брони по Bearer-токену */
  myBookings: () => request<Booking[]>('/bookings/my'),
  /** карта занятости зала сеанса (без кэша — всегда свежая) */
  seatMap: (sessionId: string) =>
    request<SeatMap>(`/sessions/${sessionId}/seats`),
  createBooking: (payload: CreateBookingPayload) =>
    request<Booking>('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** сага отмены: бронь уходит в CANCELLING, воркер возвращает платёж */
  cancelBooking: (id: string) =>
    request<Booking>(`/bookings/${id}/cancel`, {
      method: 'POST',
    }),
  /** оплата: PENDING_PAYMENT → PENDING, воркер проводит платёж */
  payBooking: (id: string) =>
    request<Booking>(`/bookings/${id}/pay`, {
      method: 'POST',
    }),
  /** регистрация: пароль хэшируется на бэкенде, вернётся UserDto */
  register: (payload: RegisterPayload) =>
    request<User>('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** вход: {accessToken, user}; токен живёт 2 часа */
  login: (payload: { email: string; password: string }) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** новый сеанс в афишу — только администратору (403 остальным) */
  createMovie: (payload: CreateMoviePayload) =>
    request<Movie>('/movies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** отзывы фильма — публичный список, свежие сверху */
  movieReviews: (movieId: string) =>
    request<Review[]>(`/movies/${movieId}/reviews`),
  /** написать отзыв: право даёт подтверждённая бронь (403 иначе, 409 дубль) */
  createReview: (movieId: string, payload: CreateReviewPayload) =>
    request<Review>(`/movies/${movieId}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** удалить отзыв — свой или админ; 204 без тела */
  deleteReview: (movieId: string, id: string) =>
    request<void>(`/movies/${movieId}/reviews/${id}`, {
      method: 'DELETE',
    }),
  /** админ-аналитика: агрегаты дашборда (403 без роли admin) */
  adminStats: () => request<AdminStatsEnvelope>('/admin/stats'),
};

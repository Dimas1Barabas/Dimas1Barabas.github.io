import type {
  AdminStatsEnvelope,
  Booking,
  BookingStats,
  BonusAccount,
  ChangePasswordPayload,
  CreateBookingPayload,
  CreateMoviePayload,
  CreatePromoPayload,
  CreateReviewPayload,
  HealthResponse,
  LoginResult,
  Movie,
  Promo,
  PromoPreview,
  RegisterPayload,
  ResetPasswordPayload,
  Review,
  SeatMap,
  Ticket,
  UpdateProfilePayload,
  User,
  ValidatePromoPayload,
  WaitlistEntry,
  MyWaitlistEntry,
} from '@/shared/api/types';

/** Базовый URL API. По умолчанию — тот же origin (vite-proxy / nginx) */
const BASE: string = import.meta.env.VITE_API_URL ?? '/api';

/** ключи localStorage для сессии (токен + пользователь) */
const TOKEN_KEY = 'cine.token';
const USER_KEY = 'cine.user';

/** полный URL эндпоинта — для EventSource, которому нужен обычный путь */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/** ws/wss URL для WebSocket (живая карта мест): https→wss, свой origin→host */
export function wsUrl(path: string): string {
  if (/^https?:\/\//.test(BASE)) return `${BASE.replace(/^http/, 'ws')}${path}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${BASE}${path}`;
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

/**
 * Транспорт: fetch + Bearer + refresh-кука. Протухший access (TTL 2 ч)
 * продлевается сам: 401 → один POST /auth/refresh (refresh-токен живёт
 * в httpOnly-cookie) → повтор исходного запроса ровно один раз.
 */
async function rawRequest<T>(
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
      // refresh-кука ездит с каждым запросом (same-origin по умолчанию и так,
      // но явное include покрывает и VITE_API_URL на другой хост)
      credentials: 'include',
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

/** refresh в полёте один на всю пачку параллельных 401 (single-flight) */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const pair = await rawRequest<LoginResult>('/auth/refresh', {
        method: 'POST',
      });
      saveAuth(pair.accessToken, pair.user);
      return true;
    } catch {
      // refresh мёртв — сессии больше нет, выходим локально
      clearAuth();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 6000,
): Promise<T> {
  try {
    return await rawRequest<T>(path, init, timeoutMs);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err;
    // auth-роуты не перехватываем: их 401 — приговор (неверный пароль,
    // дохлая сессия), а не повод обновляться
    if (path.startsWith('/auth/')) throw err;
    if (!(await refreshSession())) throw err;
    return rawRequest<T>(path, init, timeoutMs); // ровно один повтор
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
  /** оплата: PENDING_PAYMENT → PENDING, воркер проводит платёж;
   *  промокод и бонусы активируются той же транзакцией (409 промо-
   *  исчерпан / bonusOverLimit / bonusInsufficient в гонке) */
  payBooking: (id: string, promoCode?: string, useBonuses?: number) =>
    request<Booking>(`/bookings/${id}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(promoCode ? { promoCode } : {}),
        ...(useBonuses ? { useBonuses } : {}),
      }),
    }),
  /** билеты брони: по одному на место (409 bookingNotConfirmed без CONFIRMED) */
  bookingTickets: (id: string) =>
    request<Ticket[]>(`/bookings/${id}/tickets`),
  /** встать в лист ожидания полного сеанса (409 waitlistAlready/sessionNotFull) */
  joinWaitlist: (sessionId: string) =>
    request<WaitlistEntry>(`/waitlist/${sessionId}`, {
      method: 'POST',
    }),
  /** выйти из листа ожидания; 204 без тела */
  leaveWaitlist: (sessionId: string) =>
    request<void>(`/waitlist/${sessionId}`, {
      method: 'DELETE',
    }),
  /** мои активные записи (WAITING/NOTIFIED) по будущим сеансам */
  myWaitlist: () => request<MyWaitlistEntry[]>('/waitlist/my'),
  /** бонусный счёт: баланс (SUM от источника) + история движений */
  myBonuses: () => request<BonusAccount>('/bonuses/my'),
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
  /** список промокодов для админки (403 без роли admin) */
  adminPromos: () => request<Promo[]>('/promos'),
  /** создать промокод: процент или фикс, лимит активаций, срок */
  createPromo: (payload: CreatePromoPayload) =>
    request<Promo>('/promos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** превью промокода на брони — без списания активации */
  validatePromo: (payload: ValidatePromoPayload) =>
    request<PromoPreview>('/promos/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  /** выход: гасит refresh-сессию на сервере (куку снимет API) */
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  /** профиль: имя/email; ответ — свежая пара (в JWT живут клеймы) */
  updateProfile: (payload: UpdateProfilePayload) =>
    request<LoginResult>('/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** смена пароля: ревокает все сессии, это устройство получает новую пару */
  changePassword: (payload: ChangePasswordPayload) =>
    request<LoginResult>('/users/me/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  /** запрос письма сброса — всегда «отправлено», API не оракул */
  forgotPassword: (email: string) =>
    request<void>('/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
  /** сброс по одноразовой ссылке из письма (TTL 30 минут) */
  resetPassword: (payload: ResetPasswordPayload) =>
    request<LoginResult>('/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};

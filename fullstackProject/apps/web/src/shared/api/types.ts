import type { PromoKind } from '../lib/promo';

/** сеанс фильма: зал + время (у фильма их много) */
export interface MovieSession {
  id: string;
  hall: string;
  startsAt: string;
}

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
  /** средняя оценка отзывов (0 — отзывов ещё нет) */
  ratingAvg: number;
  ratingCount: number;
  /** расписание фильма, отсортировано по времени */
  sessions: MovieSession[];
}

export type BookingStatus =
  | 'PENDING_PAYMENT'
  | 'PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLING'
  | 'CANCELLED';

/** карта занятости зала сеанса — GET /api/sessions/:id/seats */
export interface SeatMap {
  sessionId: string;
  layout: { rows: number; seatsPerRow: number };
  /** коды занятых мест «ряд-место» */
  occupied: string[];
  free: number;
}

/** кадр ws-канала живой карты: полный снапшот занятости сеанса */
export interface SeatSnapshotFrame {
  type: 'snapshot';
  data: SeatMap;
}

/** кадр ошибки ws-канала (мусор/неизвестный сеанс) */
export interface SeatErrorFrame {
  type: 'error';
  message: string;
}

export type SeatFrame = SeatSnapshotFrame | SeatErrorFrame;

export interface Booking {
  id: string;
  movieId: string;
  movieTitle: string;
  movieHue: number;
  movieGenreIcon: string;
  /** сеанс, на который куплены места */
  sessionId: string;
  sessionAt: string;
  hall: string;
  customerName: string;
  /** владелец брони (null — досимвольные брони без владельца) */
  userId: string | null;
  /** коды мест «ряд-место», например ["5-7", "5-8"] */
  seats: string[];
  totalRub: number;
  /** промокод, применённый при оплате (null — без промокода) */
  promoCode: string | null;
  /** скидка применённого промокода, ₽ (null — без промокода) */
  discountRub: number | null;
  /** сколько бонусов списано при оплате (null — без бонусов), 1 бонус = 1 ₽ */
  bonusSpent: number | null;
  status: BookingStatus;
  /** дедлайн оплаты (актуален для PENDING_PAYMENT), ISO */
  expiresAt: string | null;
  message: string | null;
  processedBy: string | null;
  processedAt: string | null;
  createdAt: string;
}

export interface BookingStats {
  PENDING_PAYMENT: number;
  PENDING: number;
  CONFIRMED: number;
  FAILED: number;
  EXPIRED: number;
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
  /** бронь привязана к сеансу; фильм бэкенд выводит из сеанса */
  sessionId: string;
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

/** PATCH /users/me — оба поля опциональны, но хотя бы одно нужно */
export interface UpdateProfilePayload {
  email?: string;
  name?: string;
}

/** PUT /users/me/password — старый обязателен, смена ревокает все сессии */
export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

/** POST /auth/reset-password — одноразовый токен из письма */
export interface ResetPasswordPayload {
  token: string;
  newPassword: string;
}

/** новый фильм в афишу — POST /api/movies (только админ), сразу с сеансами */
export interface CreateMoviePayload {
  title: string;
  description: string;
  genre: string;
  genreIcon: string;
  durationMin: number;
  priceRub: number;
  hue: number;
  /** хотя бы один сеанс */
  sessions: { hall: string; startsAt: string }[];
}

/** отзыв на фильм — GET /movies/:id/reviews (публично) */
export interface Review {
  id: string;
  movieId: string;
  userId: string;
  authorName: string;
  /** оценка 1–5 */
  rating: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** POST /movies/:id/reviews: право на отзыв проверяет бэкенд по брони */
export interface CreateReviewPayload {
  rating: number;
  text: string;
}

/** GET /api/admin/stats — агрегаты админ-дашборда (только роль admin) */
export interface AdminTotals {
  bookingsTotal: number;
  confirmed: number;
  /** выручка по CONFIRMED-броням, ₽ */
  revenueRub: number;
  avgTicketRub: number;
  seatsSold: number;
  /** средняя заполняемость предстоящих сеансов, % */
  upcomingOccupancyPct: number;
  moviesCount: number;
  reviewsCount: number;
  avgRating: number;
}

export type AdminStatusCounts = Record<BookingStatus, number>;

export interface AdminTopMovie {
  movieId: string;
  title: string;
  bookings: number;
  seats: number;
  revenueRub: number;
}

export interface AdminSessionOccupancy {
  sessionId: string;
  movieTitle: string;
  hall: string;
  startsAt: string;
  occupied: number;
  capacity: number;
  occupancyPct: number;
}

export interface AdminDayRevenue {
  /** локальный день YYYY-MM-DD */
  day: string;
  bookings: number;
  revenueRub: number;
}

export interface AdminStats {
  totals: AdminTotals;
  byStatus: AdminStatusCounts;
  topMovies: AdminTopMovie[];
  upcomingSessions: AdminSessionOccupancy[];
  revenueByDay: AdminDayRevenue[];
}

/** конверт: источник агрегатов виден бейджем «из кэша» (Redis, TTL 30 c) */
export interface AdminStatsEnvelope {
  source: 'cache' | 'db';
  data: AdminStats;
}

/** промокод — GET/POST /api/promos (админ) */
export interface Promo {
  id: string;
  code: string;
  kind: PromoKind;
  /** проценты (1–99) или рубли — по kind */
  value: number;
  maxActivations: number;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
}

export interface CreatePromoPayload {
  code: string;
  kind: PromoKind;
  value: number;
  maxActivations: number;
  expiresAt: string;
}

export interface ValidatePromoPayload {
  code: string;
  bookingId: string;
}

/** превью промокода на брони — POST /api/promos/validate (без списания) */
export interface PromoPreview {
  code: string;
  kind: PromoKind;
  value: number;
  /** скидка, ₽ */
  discountRub: number;
  /** итог после скидки, ₽ */
  totalRub: number;
}

/**
 * Билет на место — GET /api/bookings/:id/tickets. Производная брони:
 * выдаётся только по CONFIRMED, живёт, пока бронь жива. QR-строку
 * «на вход в зал» фронт собирает из полей сам (shared/lib/ticket).
 */
export interface Ticket {
  bookingId: string;
  /** код «ряд-место» */
  seat: string;
  /** номер билета — детерминирован (бронь + место + сеанс) */
  ticketNo: string;
  /** HMAC-SHA256 канонической строки, первые 128 бит (hex) */
  signature: string;
  movieTitle: string;
  movieHue: number;
  movieGenreIcon: string;
  sessionAt: string;
  hall: string;
  customerName: string;
}

export type TicketRefusalReason =
  | 'malformedPayload'
  | 'badSignature'
  | 'bookingNotFound'
  | 'bookingNotConfirmed'
  | 'seatMismatch'
  | 'sessionPassed';

/** вердикт сканера на входе — POST /api/bookings/tickets/verify (admin) */
export interface TicketVerifyResult {
  valid: boolean;
  reason: TicketRefusalReason | null;
  bookingId: string | null;
  seat: string | null;
  movieTitle: string | null;
  sessionAt: string | null;
  hall: string | null;
  customerName: string | null;
}

/** статусы записи в листе ожидания полного сеанса */
export type WaitlistStatus = 'WAITING' | 'NOTIFIED' | 'LEFT';

/** запись в листе ожидания — ответ POST /api/waitlist/:sessionId */
export interface WaitlistEntry {
  id: string;
  sessionId: string;
  userId: string;
  status: WaitlistStatus;
  /** позиция среди WAITING (1 — голова); null, если уже не в очереди */
  position: number | null;
  queuedAt: string;
  notifiedAt: string | null;
  createdAt: string;
}

/** запись с контекстом сеанса — элемент GET /api/waitlist/my */
export interface MyWaitlistEntry extends WaitlistEntry {
  movieId: string;
  movieTitle: string;
  hall: string;
  startsAt: string;
}

/** «место освободилось» — SSE-событие waitlist (фильтрация «моё» на клиенте) */
export interface WaitlistStreamEvent {
  userId: string;
  sessionId: string;
  movieId: string;
  movieTitle: string;
  hall: string;
  sessionAt: string;
  seats: string[];
  notifiedAt: string;
}

/** направления движений бонусного счёта: accrual — начисление, spend — списание */
export type BonusKind = 'accrual' | 'spend';

/**
 * Причины движений — почему изменился баланс. Одна операция одного типа
 * по бронь не задваивается (uq в Postgres).
 */
export type BonusReason =
  | 'cashback'
  | 'payment'
  | 'payment_failed'
  | 'refund'
  | 'clawback';

/** движение счёта — элемент истории GET /api/bonuses/my */
export interface BonusTransaction {
  id: string;
  kind: BonusKind;
  reason: BonusReason;
  /** сколько бонусов (положительное целое; направление — в kind) */
  amount: number;
  /** бронь-источник движения */
  bookingId: string;
  createdAt: string;
}

/** бонусный счёт — GET /api/bonuses/my: баланс от источника + история */
export interface BonusAccount {
  balance: number;
  transactions: BonusTransaction[];
}

/** позиция топа «Вам понравится» — GET /api/recommendations/my */
export interface RecommendationItem {
  movieId: string;
  title: string;
  genre: string;
  /** нормализованный скор 0..1 */
  score: number;
  /** причина на русском: «вы часто смотрите «фантастика»» */
  reason: string;
}

/**
 * На чём построен топ: profile — по сигналам зрителя, popular — холодный
 * старт по рейтингу, empty — советовать нечего; unavailable — КиноСоветник
 * не ответил, блок на витрине скрывается (это не ошибка запроса).
 */
export type RecommendationsBasis =
  | 'profile'
  | 'popular'
  | 'empty'
  | 'unavailable';

/** ответ КиноСоветника */
export interface RecommendationsDto {
  items: RecommendationItem[];
  basis: RecommendationsBasis;
}

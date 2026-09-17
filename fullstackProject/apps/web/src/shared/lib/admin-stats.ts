import type {
  AdminDayRevenue,
  AdminSessionOccupancy,
  AdminStatusCounts,
  AdminTopMovie,
  AdminTotals,
  Booking,
  BookingStatus,
} from '@/shared/api/types';
import { HALL_CAPACITY } from '@/shared/lib/hall';

/**
 * Чистые агрегаты админ-аналитики — зеркало admin-stats.logic.ts в API.
 * Живой стенд считает их в NestJS по Postgres, демо-режим — здесь по
 * состоянию движка; контракт один (AdminStats), поэтому экран /admin/stats
 * не различает источники.
 */

/** сколько дней показывает график выручки (включая сегодня) */
export const REVENUE_DAYS = 14;

export const EMPTY_STATUS_COUNTS = (): AdminStatusCounts => ({
  PENDING_PAYMENT: 0,
  PENDING: 0,
  CONFIRMED: 0,
  FAILED: 0,
  EXPIRED: 0,
  CANCELLING: 0,
  CANCELLED: 0,
});

/** локальный день YYYY-MM-DD: графики в поясе клиента, не в UTC */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function countByStatus(rows: Booking[]): AdminStatusCounts {
  const counts = EMPTY_STATUS_COUNTS();
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * Выручка по дням за REVENUE_DAYS включая сегодня: CONFIRMED-брони,
 * день — вердикт (processedAt), фолбэк — создание. Пустые дни — нули.
 */
export function revenueByDay(
  rows: Booking[],
  now: Date = new Date(),
): AdminDayRevenue[] {
  const byDay = new Map<string, { bookings: number; revenueRub: number }>();
  for (const row of rows) {
    if (row.status !== 'CONFIRMED') continue;
    const at = row.processedAt ?? row.createdAt;
    const key = dayKey(new Date(at));
    const agg = byDay.get(key) ?? { bookings: 0, revenueRub: 0 };
    agg.bookings += 1;
    agg.revenueRub += row.totalRub;
    byDay.set(key, agg);
  }

  const days: AdminDayRevenue[] = [];
  for (let i = REVENUE_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const agg = byDay.get(key);
    days.push({
      day: key,
      bookings: agg?.bookings ?? 0,
      revenueRub: agg?.revenueRub ?? 0,
    });
  }
  return days;
}

/** топ фильмов по подтверждённым броням (ничья — по выручке) */
export function topMovies(
  rows: Booking[],
  titles: Map<string, string>,
  limit = 5,
): AdminTopMovie[] {
  const byMovie = new Map<
    string,
    { bookings: number; seats: number; revenueRub: number }
  >();
  for (const row of rows) {
    if (row.status !== 'CONFIRMED') continue;
    const agg = byMovie.get(row.movieId) ?? { bookings: 0, seats: 0, revenueRub: 0 };
    agg.bookings += 1;
    agg.seats += row.seats.length;
    agg.revenueRub += row.totalRub;
    byMovie.set(row.movieId, agg);
  }
  return [...byMovie.entries()]
    .map(([movieId, agg]) => ({
      movieId,
      title: titles.get(movieId) ?? '—',
      ...agg,
    }))
    .sort((a, b) => b.bookings - a.bookings || b.revenueRub - a.revenueRub)
    .slice(0, limit);
}

/** средняя оценка по отзывам: до сотых, 0 без отзывов */
export function ratingAgg(
  reviews: { rating: number }[],
): { count: number; avg: number } {
  if (!reviews.length) return { count: 0, avg: 0 };
  const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
  return {
    count: reviews.length,
    avg: Math.round((sum / reviews.length) * 100) / 100,
  };
}

/** заполняемость предстоящих сеансов: ближайшие limit и средняя */
export function sessionOccupancy(
  sessions: {
    id: string;
    movieTitle: string;
    hall: string;
    startsAt: Date;
  }[],
  occupiedBySession: Map<string, number>,
  limit = 8,
): { list: AdminSessionOccupancy[]; avgPct: number } {
  const list = sessions.map((s) => {
    const occupied = occupiedBySession.get(s.id) ?? 0;
    return {
      sessionId: s.id,
      movieTitle: s.movieTitle,
      hall: s.hall,
      startsAt: s.startsAt.toISOString(),
      occupied,
      capacity: HALL_CAPACITY,
      occupancyPct: Math.round((occupied / HALL_CAPACITY) * 100),
    };
  });
  const avgPct = list.length
    ? Math.round(list.reduce((acc, s) => acc + s.occupancyPct, 0) / list.length)
    : 0;
  return { list: list.slice(0, limit), avgPct };
}

/** сводка KPI по броням + внешние агрегаты (фильмы, отзывы, сеансы) */
export function adminTotals(
  bookings: Booking[],
  extra: {
    moviesCount: number;
    reviewsCount: number;
    avgRating: number;
    upcomingAvgPct: number;
  },
): AdminTotals {
  const confirmedRows = bookings.filter((b) => b.status === 'CONFIRMED');
  const revenueRub = confirmedRows.reduce((acc, b) => acc + b.totalRub, 0);
  const confirmed = confirmedRows.length;
  return {
    bookingsTotal: bookings.length,
    confirmed,
    revenueRub,
    avgTicketRub: confirmed ? Math.round(revenueRub / confirmed) : 0,
    seatsSold: confirmedRows.reduce((acc, b) => acc + b.seats.length, 0),
    upcomingOccupancyPct: extra.upcomingAvgPct,
    moviesCount: extra.moviesCount,
    reviewsCount: extra.reviewsCount,
    avgRating: extra.avgRating,
  };
}

/** все статусы статусной машины — для перебора в UI/тестах */
export const BOOKING_STATUSES: BookingStatus[] = [
  'PENDING_PAYMENT',
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'EXPIRED',
  'CANCELLING',
  'CANCELLED',
];

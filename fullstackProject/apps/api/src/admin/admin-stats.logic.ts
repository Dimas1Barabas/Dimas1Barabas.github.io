import { BOOKING_STATUSES, BookingStatus } from '../bookings/booking.entity';
import { HALL_CAPACITY } from '../bookings/hall';
import type {
  AdminDayRevenueDto,
  AdminSessionOccupancyDto,
  AdminStatusCountsDto,
  AdminTopMovieDto,
  AdminTotalsDto,
} from './dto/admin-stats.dto';

/**
 * Чистые функции агрегации админ-аналитики — без БД и кэша, только
 * арифметика по выгруженным строкам (как computeTotal в booking.logic.ts).
 * Объём демо-кинотеатра мал, поэтому считаем в JS: легко юнит-тестировать;
 * при росте — менять на GROUP BY в SQL, контракт не меняется.
 */

/** строка брони, достаточная для всех агрегатов */
export interface BookingFact {
  status: BookingStatus;
  totalRub: number;
  seats: string[];
  movieId: string;
  createdAt: Date;
  processedAt: Date | null;
}

/** сколько дней показывает график выручки (включая сегодня) */
export const REVENUE_DAYS = 14;

/** локальный день YYYY-MM-DD — графики считаем в поясе сервера/клиента,
 *  не в UTC: полуночная продажа не должна уезжать во вчерашний столбец */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** счётчики по статусам; отсутствующие статусы — нули (все 7 ключей) */
export function countByStatus(rows: BookingFact[]): AdminStatusCountsDto {
  const counts = {} as AdminStatusCountsDto;
  for (const status of BOOKING_STATUSES) counts[status] = 0;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * Выручка по дням за REVENUE_DAYS дней включая сегодня: CONFIRMED-брони,
 * день — дата вердикта воркера (processedAt), с фолбэком на день создания.
 * Пустые дни — нулевые столбцы, чтобы график не «сжимался».
 */
export function revenueByDay(
  rows: BookingFact[],
  now: Date = new Date(),
): AdminDayRevenueDto[] {
  const byDay = new Map<string, { bookings: number; revenueRub: number }>();
  for (const row of rows) {
    if (row.status !== 'CONFIRMED') continue;
    const key = dayKey(row.processedAt ?? row.createdAt);
    const agg = byDay.get(key) ?? { bookings: 0, revenueRub: 0 };
    agg.bookings += 1;
    agg.revenueRub += row.totalRub;
    byDay.set(key, agg);
  }

  const days: AdminDayRevenueDto[] = [];
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
  rows: BookingFact[],
  titleById: Map<string, string>,
  limit = 5,
): AdminTopMovieDto[] {
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
      title: titleById.get(movieId) ?? '—',
      ...agg,
    }))
    .sort((a, b) => b.bookings - a.bookings || b.revenueRub - a.revenueRub)
    .slice(0, limit);
}

/** заполняемость предстоящих сеансов: список (ближайшие limit) и средняя */
export function upcomingOccupancy(
  sessions: {
    id: string;
    movieTitle: string;
    hall: string;
    startsAt: Date;
  }[],
  occupiedBySession: Map<string, number>,
  limit = 8,
): { list: AdminSessionOccupancyDto[]; avgPct: number } {
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
    ? Math.round(
        list.reduce((acc, s) => acc + s.occupancyPct, 0) / list.length,
      )
    : 0;
  return { list: list.slice(0, limit), avgPct };
}

/** средняя оценка по отзывам: округление до сотых, 0 без отзывов */
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

/** сводка: числа для KPI-плиток дашборда */
export function totals(
  bookings: BookingFact[],
  extra: {
    moviesCount: number;
    reviewsCount: number;
    avgRating: number;
    upcomingAvgPct: number;
  },
): AdminTotalsDto {
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

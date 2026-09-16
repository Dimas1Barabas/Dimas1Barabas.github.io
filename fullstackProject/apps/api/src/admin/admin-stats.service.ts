import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { Booking } from '../bookings/booking.entity';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { Review } from '../reviews/review.entity';
import { RedisService } from '../redis/redis.service';
import type { AdminStatsDto, AdminStatsResultDto } from './dto/admin-stats.dto';
import {
  countByStatus,
  ratingAgg,
  revenueByDay,
  topMovies,
  totals,
  upcomingOccupancy,
} from './admin-stats.logic';

// v1: первая форма ответа аналитики. При смене формы — бампнуть суффикс,
// чтобы старые значения не доживали свой TTL в новом коде (как movies:all)
export const ADMIN_STATS_KEY = 'admin:stats:v1';
const ADMIN_STATS_TTL_SEC = 30;

/**
 * Аналитика для админ-дашборда: выгружает строки и агрегирует их чистыми
 * функциями (admin-stats.logic.ts). Результат кэшируется в Redis — дашборд
 * перекликивается часто, а мигрирующие статусы броней всё равно видны с
 * задержкой в полминуты.
 */
@Injectable()
export class AdminStatsService {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(SeatOccupancy)
    private readonly occupancy: Repository<SeatOccupancy>,
    @InjectRepository(Session) private readonly sessions: Repository<Session>,
    @InjectRepository(Movie) private readonly movies: Repository<Movie>,
    @InjectRepository(Review) private readonly reviews: Repository<Review>,
    private readonly redis: RedisService,
  ) {}

  async getStats(): Promise<AdminStatsResultDto> {
    const { value, source } = await this.redis.withCache<AdminStatsDto>(
      ADMIN_STATS_KEY,
      ADMIN_STATS_TTL_SEC,
      () => this.load(),
    );
    return { source, data: value };
  }

  private async load(): Promise<AdminStatsDto> {
    const [bookingRows, occupancyRows, sessionRows, movieRows, reviewRows] =
      await Promise.all([
        this.bookings.find(),
        this.occupancy.find(),
        this.sessions.find({
          where: { startsAt: MoreThanOrEqual(new Date()) },
          relations: { movie: true },
          order: { startsAt: 'ASC' },
        }),
        this.movies.find(),
        this.reviews.find(),
      ]);

    const occupiedBySession = new Map<string, number>();
    for (const row of occupancyRows) {
      occupiedBySession.set(
        row.sessionId,
        (occupiedBySession.get(row.sessionId) ?? 0) + 1,
      );
    }
    const titleById = new Map(movieRows.map((m) => [m.id, m.title]));
    const ratings = ratingAgg(reviewRows);
    const upcoming = upcomingOccupancy(
      sessionRows.map((s) => ({
        id: s.id,
        movieTitle: s.movie?.title ?? '—',
        hall: s.hall,
        startsAt: s.startsAt,
      })),
      occupiedBySession,
    );

    return {
      totals: totals(bookingRows, {
        moviesCount: movieRows.length,
        reviewsCount: ratings.count,
        avgRating: ratings.avg,
        upcomingAvgPct: upcoming.avgPct,
      }),
      byStatus: countByStatus(bookingRows),
      topMovies: topMovies(bookingRows, titleById),
      upcomingSessions: upcoming.list,
      revenueByDay: revenueByDay(bookingRows),
    };
  }
}

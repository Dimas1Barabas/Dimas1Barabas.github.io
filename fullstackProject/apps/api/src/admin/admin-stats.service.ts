import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { Booking } from '../bookings/booking.entity';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { GiftCertificate } from '../gifts/gift-certificate.entity';
import { GiftSpend } from '../gifts/gift-spend.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { Review } from '../reviews/review.entity';
import { RedisService } from '../redis/redis.service';
import { User } from '../users/user.entity';
import type { AdminStatsDto, AdminStatsResultDto } from './dto/admin-stats.dto';
import {
  countByStatus,
  giftStats,
  ratingAgg,
  referralStats,
  revenueByDay,
  topMovies,
  totals,
  upcomingOccupancy,
} from './admin-stats.logic';

// v3: к v2 добавлен гифт-срез (этап 33). При смене формы —
// бампнуть суффикс, чтобы старые значения не доживали свой TTL
// в новом коде (как movies:all)
export const ADMIN_STATS_KEY = 'admin:stats:v3';
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
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(BonusTransaction)
    private readonly bonusLedger: Repository<BonusTransaction>,
    @InjectRepository(GiftCertificate)
    private readonly giftCerts: Repository<GiftCertificate>,
    @InjectRepository(GiftSpend)
    private readonly giftSpends: Repository<GiftSpend>,
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
    const [
      bookingRows,
      occupancyRows,
      sessionRows,
      movieRows,
      reviewRows,
      invitedRows,
      referralBonusRows,
      giftCertRows,
      giftSpendRows,
    ] = await Promise.all([
      this.bookings.find(),
      this.occupancy.find(),
      this.sessions.find({
        where: { startsAt: MoreThanOrEqual(new Date()) },
        relations: { movie: true },
        order: { startsAt: 'ASC' },
      }),
      this.movies.find(),
      this.reviews.find(),
      // реферальный срез: приглашённые + начисления обеим сторонам
      this.users.find({ where: { referredBy: Not(IsNull()) } }),
      this.bonusLedger.find({
        where: { kind: 'accrual', reason: In(['referral', 'referral_welcome']) },
      }),
      // гифт-срез: карты и живые траты (возвраты не считаются)
      this.giftCerts.find(),
      this.giftSpends.find({ where: { reversedAt: IsNull() } }),
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
      referrals: referralStats(
        invitedRows,
        referralBonusRows.map((r) => r.amount),
      ),
      gifts: giftStats(
        giftCertRows,
        giftSpendRows.map((s) => s.amount),
      ),
    };
  }
}

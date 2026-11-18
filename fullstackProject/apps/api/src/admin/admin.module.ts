import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { GiftCertificate } from '../gifts/gift-certificate.entity';
import { GiftSpend } from '../gifts/gift-spend.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { Review } from '../reviews/review.entity';
import { User } from '../users/user.entity';
import { AdminController } from './admin.controller';
import { AdminStatsService } from './admin-stats.service';

/** админ-аналитика: агрегаты по броням, местам, сеансам, фильмам, отзывам, рефералке и гифтам */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      SeatOccupancy,
      Session,
      Movie,
      Review,
      User,
      BonusTransaction,
      GiftCertificate,
      GiftSpend,
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminStatsService],
})
export class AdminModule {}

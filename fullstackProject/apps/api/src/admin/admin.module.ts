import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { Review } from '../reviews/review.entity';
import { User } from '../users/user.entity';
import { AdminController } from './admin.controller';
import { AdminStatsService } from './admin-stats.service';

/** админ-аналитика: агрегаты по броням, местам, сеансам, фильмам, отзывам и рефералке */
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
    ]),
  ],
  controllers: [AdminController],
  providers: [AdminStatsService],
})
export class AdminModule {}

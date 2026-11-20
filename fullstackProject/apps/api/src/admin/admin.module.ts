import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { BookingsModule } from '../bookings/bookings.module';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { FraudModule } from '../fraud/fraud.module';
import { FraudAdminController } from '../fraud/fraud-admin.controller';
import { GiftCertificate } from '../gifts/gift-certificate.entity';
import { GiftSpend } from '../gifts/gift-spend.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { Review } from '../reviews/review.entity';
import { User } from '../users/user.entity';
import { AdminController } from './admin.controller';
import { AdminStatsService } from './admin-stats.service';

/**
 * админ-аналитика: агрегаты по броням, местам, сеансам, фильмам, отзывам,
 * рефералке и гифтам; антифрод-витрина (этап 36) — контроллер здесь, а не
 * во FraudModule: ему нужен BookingsService для системных оплаты/отмены,
 * а BookingsModule импортирует FraudModule ради клиента скоринга
 */
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
    // системные пути ревью антифрода (payReviewed/cancelReviewed)
    BookingsModule,
    // клиенты «Детектива»: скоринг-резолвы и HTTP-витрина решений
    FraudModule,
  ],
  controllers: [AdminController, FraudAdminController],
  providers: [AdminStatsService],
})
export class AdminModule {}

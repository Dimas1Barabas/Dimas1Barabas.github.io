import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { Movie } from '../movies/movie.entity';
import { OutboxModule } from '../outbox/outbox.module';
import { Review } from './review.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  // Сигнал КиноСоветнику при создании отзыва едет через outbox —
  // брокеровых зависимостей у модуля больше нет, доставит Курьер
  imports: [
    TypeOrmModule.forFeature([Review, Movie, Booking]),
    // OutboxModule — будильник Курьера после коммита отзыва
    OutboxModule,
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}

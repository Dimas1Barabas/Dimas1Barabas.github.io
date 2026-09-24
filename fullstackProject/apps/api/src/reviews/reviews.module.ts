import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { Movie } from '../movies/movie.entity';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { Review } from './review.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  // rabbitMqModule — публикация сигнала КиноСоветнику при создании отзыва
  imports: [TypeOrmModule.forFeature([Review, Movie, Booking]), rabbitMqModule],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}

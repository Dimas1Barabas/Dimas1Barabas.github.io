import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { Movie } from '../movies/movie.entity';
import { Review } from './review.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  imports: [TypeOrmModule.forFeature([Review, Movie, Booking])],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}

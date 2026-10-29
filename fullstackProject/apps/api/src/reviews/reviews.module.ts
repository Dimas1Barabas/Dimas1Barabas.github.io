import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { Movie } from '../movies/movie.entity';
import { OutboxModule } from '../outbox/outbox.module';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { Review } from './review.entity';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  // rabbitMqModule — консьюмеры контрактов; сигнал КиноСоветнику при
  // создании отзыва теперь едет через outbox (доставит Курьер)
  imports: [
    TypeOrmModule.forFeature([Review, Movie, Booking]),
    rabbitMqModule,
    // OutboxModule — будильник Курьера после коммита отзыва
    OutboxModule,
  ],
  controllers: [ReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}

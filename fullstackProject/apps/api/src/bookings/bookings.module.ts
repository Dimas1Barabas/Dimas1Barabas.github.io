import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { Booking } from './booking.entity';
import { BookingsConsumer } from './bookings.consumer';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({
  // rabbitMqModule — чтобы инжектить AmqpConnection (публикация событий)
  imports: [TypeOrmModule.forFeature([Booking, Movie]), rabbitMqModule],
  controllers: [BookingsController],
  providers: [BookingsService, BookingsConsumer],
})
export class BookingsModule {}

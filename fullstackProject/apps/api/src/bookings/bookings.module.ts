import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { Booking } from './booking.entity';
import { BookingStream } from './booking-stream';
import { BookingsConsumer } from './bookings.consumer';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { SeatOccupancy } from './seat-occupancy.entity';
import { SeatsController } from './seats.controller';

@Module({
  // rabbitMqModule — чтобы инжектить AmqpConnection (публикация событий)
  imports: [
    TypeOrmModule.forFeature([Booking, Movie, SeatOccupancy]),
    rabbitMqModule,
  ],
  controllers: [BookingsController, SeatsController],
  providers: [BookingsService, BookingsConsumer, BookingStream],
})
export class BookingsModule {}

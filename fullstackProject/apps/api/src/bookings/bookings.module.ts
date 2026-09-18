import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { Promo } from '../promos/promo.entity';
import { Session } from '../movies/session.entity';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { Booking } from './booking.entity';
import { BookingStream } from './booking-stream';
import { BookingsConsumer } from './bookings.consumer';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { SeatOccupancy } from './seat-occupancy.entity';
import { SeatsController } from './seats.controller';

@Module({
  // rabbitMqModule — чтобы инжектить AmqpConnection (публикация событий);
  // Promo — причина отказа активации после отката транзакции оплаты
  imports: [
    TypeOrmModule.forFeature([Booking, Movie, Session, SeatOccupancy, Promo]),
    rabbitMqModule,
  ],
  controllers: [BookingsController, SeatsController],
  providers: [BookingsService, BookingsConsumer, BookingStream],
})
export class BookingsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { Promo } from '../promos/promo.entity';
import { Session } from '../movies/session.entity';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { WaitlistEntry } from '../waitlist/waitlist.entity';
import { Booking } from './booking.entity';
import { BookingStream } from './booking-stream';
import { BookingsConsumer } from './bookings.consumer';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { SeatMapGateway } from './seat-map.gateway';
import { SeatOccupancy } from './seat-occupancy.entity';
import { SeatsController } from './seats.controller';
import { SeatStream } from './seat-stream';

@Module({
  // rabbitMqModule — чтобы инжектить AmqpConnection (публикация событий);
  // Promo — причина отказа активации после отката транзакции оплаты;
  // WaitlistEntry — бронь гасит запись в листе ожидания (create → LEFT)
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      Movie,
      Session,
      SeatOccupancy,
      Promo,
      WaitlistEntry,
    ]),
    rabbitMqModule,
  ],
  controllers: [BookingsController, SeatsController],
  // SeatStream + SeatMapGateway — живая карта мест по WS: та же нора,
  // что и данные занятости (BookingsService), экспортировать наружу не нужно
  providers: [BookingsService, BookingsConsumer, BookingStream, SeatStream, SeatMapGateway],
  // BookingStream нужен и waitlist-консьюмеру: тот же SSE-эндпоинт,
  // второй канал событий — см. waitlist.module
  exports: [BookingStream],
})
export class BookingsModule {}

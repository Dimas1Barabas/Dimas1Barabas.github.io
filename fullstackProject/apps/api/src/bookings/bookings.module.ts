import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { Movie } from '../movies/movie.entity';
import { Promo } from '../promos/promo.entity';
import { Session } from '../movies/session.entity';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { RemindersClient } from '../reminders/reminders.client';
import { User } from '../users/user.entity';
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
  // WaitlistEntry — бронь гасит запись в листе ожидания (create → LEFT);
  // BonusTransaction — списание в pay и реверсы вердиктов ledger'ом;
  // User — email адресата «письма»-напоминания (напрямую репозиторием,
  // как waitlist — без импорта UsersModule, цикла нет)
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      Movie,
      Session,
      SeatOccupancy,
      Promo,
      WaitlistEntry,
      BonusTransaction,
      User,
    ]),
    rabbitMqModule,
  ],
  controllers: [BookingsController, SeatsController],
  // SeatStream + SeatMapGateway — живая карта мест по WS: та же нора,
  // что и данные занятости (BookingsService), экспортировать наружу не нужно
  providers: [BookingsService, BookingsConsumer, BookingStream, SeatStream, SeatMapGateway, RemindersClient],
  // BookingStream нужен и waitlist-консьюмеру: тот же SSE-эндпоинт,
  // второй канал событий — см. waitlist.module; RemindersClient —
  // вердиктным хукам (schedule/cancel), а RemindersModule импортирует
  // нас однонаправленно: цикл модулей не возникает
  exports: [BookingStream, RemindersClient],
})
export class BookingsModule {}

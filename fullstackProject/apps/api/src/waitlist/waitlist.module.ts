import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookingsModule } from '../bookings/bookings.module';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { Movie } from '../movies/movie.entity';
import { Session } from '../movies/session.entity';
import { User } from '../users/user.entity';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { WaitlistEntry } from './waitlist.entity';
import { WaitlistConsumer } from './waitlist.consumer';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  // Session — гварды join (будущий сеанс), SeatOccupancy — полнота зала,
  // Movie/User — контекст уведомления при освобождении места.
  // BookingsModule экспортирует BookingStream: тот же инстанс шины, что
  // у SSE-эндпоинта, — второй канал событий (waitlist$) доходит до клиентов.
  imports: [
    BookingsModule,
    TypeOrmModule.forFeature([WaitlistEntry, Session, SeatOccupancy, Movie, User]),
    rabbitMqModule,
  ],
  controllers: [WaitlistController],
  providers: [WaitlistService, WaitlistConsumer],
})
export class WaitlistModule {}

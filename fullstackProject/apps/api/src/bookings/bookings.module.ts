import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { Booking } from './booking.entity';
import { BookingsConsumer } from './bookings.consumer';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({
  imports: [TypeOrmModule.forFeature([Booking, Movie])],
  controllers: [BookingsController],
  providers: [BookingsService, BookingsConsumer],
})
export class BookingsModule {}

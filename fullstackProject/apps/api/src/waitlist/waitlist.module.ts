import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SeatOccupancy } from '../bookings/seat-occupancy.entity';
import { Session } from '../movies/session.entity';
import { WaitlistEntry } from './waitlist.entity';
import { WaitlistController } from './waitlist.controller';
import { WaitlistService } from './waitlist.service';

@Module({
  // Session — гварды join (будущий сеанс), SeatOccupancy — полнота зала
  imports: [TypeOrmModule.forFeature([WaitlistEntry, Session, SeatOccupancy])],
  controllers: [WaitlistController],
  providers: [WaitlistService],
})
export class WaitlistModule {}

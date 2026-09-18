import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { Promo } from './promo.entity';
import { PromosController } from './promos.controller';
import { PromosService } from './promos.service';

@Module({
  // Booking-репозиторий нужен превью промокода на брони (без сервиса — цикла нет)
  imports: [TypeOrmModule.forFeature([Promo, Booking])],
  controllers: [PromosController],
  providers: [PromosService],
})
export class PromosModule {}

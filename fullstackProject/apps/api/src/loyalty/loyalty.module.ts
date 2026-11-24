import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';

/**
 * Уровни лояльности «Киноман» (этап 38). Читает bookings как источник
 * трат — таблицы своей нет, денормализации нет. Сервис экспортируется:
 * вердиктный цикл берёт прибавку кэшбэка и детектит повышение,
 * кинобар — скидку уровня, создание брони — tier для Тарификатора.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Booking])],
  controllers: [LoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}

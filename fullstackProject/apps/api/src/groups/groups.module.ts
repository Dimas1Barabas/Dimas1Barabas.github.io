import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { GroupGateway } from './group.gateway';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/**
 * «Идём вместе» (этап 40): групповой выбор мест.
 *
 * BookingsModule — ради BookingsService.seatMap(): валидация сеанса при
 * создании группы и занятость внешними бронями в комнатных кадрах.
 * Хранений нет: группы живут в памяти GroupsService.
 */
@Module({
  imports: [BookingsModule],
  controllers: [GroupsController],
  providers: [GroupsService, GroupGateway],
})
export class GroupsModule {}

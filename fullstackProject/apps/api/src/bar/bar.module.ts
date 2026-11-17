import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '../outbox/outbox.module';
import { BarItem } from './bar-item.entity';
import { BarOrder, BarOrderItem } from './bar-order.entity';
import { BarController } from './bar.controller';
import { BarService } from './bar.service';

/**
 * Кинобар (этап 32): предзаказ попкорна и напитков. Каталог и заказы —
 * в основной БД API; очередь приготовления держит Go-сервис «Бармен»
 * в собственной базе, статусы возвращаются событием bar.order.status.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BarItem, BarOrder, BarOrderItem]), OutboxModule],
  controllers: [BarController],
  providers: [BarService],
})
export class BarModule {}

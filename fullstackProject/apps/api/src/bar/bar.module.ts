import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { OutboxModule } from '../outbox/outbox.module';
import { BarItem } from './bar-item.entity';
import { BarOrder, BarOrderItem } from './bar-order.entity';
import { BarController } from './bar.controller';
import { BarConsumer } from './bar.consumer';
import { BarService } from './bar.service';

/**
 * Кинобар (этап 32): предзаказ попкорна и напитков. Каталог и заказы —
 * в основной БД API; очередь приготовления держит Go-сервис «Бармен»
 * в собственной базе, статусы возвращаются событием bar.order.status
 * (консьюмер ниже), «письмо» о готовности шлёт notification-service.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BarItem, BarOrder, BarOrderItem]),
    LoyaltyModule, // скидка уровня «Киноман» на итог заказа (этап 38)
    OutboxModule,
  ],
  controllers: [BarController],
  providers: [BarService, BarConsumer],
})
export class BarModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BonusTransaction } from './bonus-transaction.entity';
import { BonusController } from './bonus.controller';
import { BonusService } from './bonus.service';

/**
 * Бонусный счёт — витрина ledger'а: операции (списание в pay, кэшбэк
 * и реверсы в вердиктах воркера) делает BookingsService в своих
 * транзакциях; модуль отвечает только за чтение счёта.
 */
@Module({
  imports: [TypeOrmModule.forFeature([BonusTransaction])],
  controllers: [BonusController],
  providers: [BonusService],
})
export class BonusModule {}

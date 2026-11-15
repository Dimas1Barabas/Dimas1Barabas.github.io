import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BonusTransaction } from '../bonus/bonus-transaction.entity';
import { User } from '../users/user.entity';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';

/**
 * Реферальная программа — витрина: привязка referred_by делает
 * UsersService.register, начисление бонусов — BookingsService в
 * транзакции вердикта; модуль отвечает за код приглашения и чтение
 * статистики.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, BonusTransaction])],
  controllers: [ReferralsController],
  providers: [ReferralsService],
})
export class ReferralsModule {}

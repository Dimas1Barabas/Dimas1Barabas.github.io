import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { BackupCode } from './backup-code.entity';
import { TrustedDevice } from './trusted-device.entity';
import { TwoFactorChallenge } from './two-factor-challenge.entity';
import { TwoFactorController } from './twofactor.controller';
import { TwoFactorService } from './twofactor.service';

/**
 * Двухфакторная аутентификация: настройки в профиле (контроллер) +
 * сервис для AuthModule (билеты и коды второго шага логина). Сущность
 * User — общая с UsersModule: репозиторий живёт в forFeature, модули
 * друг друга не импортируют (без циклов).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, BackupCode, TrustedDevice, TwoFactorChallenge]),
  ],
  controllers: [TwoFactorController],
  providers: [TwoFactorService],
  exports: [TwoFactorService],
})
export class TwoFactorModule {}

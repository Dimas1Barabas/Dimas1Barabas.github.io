import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '../outbox/outbox.module';
import { RatelimiterModule } from '../ratelimiter/ratelimiter.module';
import { TokensModule } from '../tokens/tokens.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { PasswordReset } from './password-reset.entity';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    // JwtModule живёт в TokensModule (подпись пары + JwtService для стратегии)
    TokensModule,
    TypeOrmModule.forFeature([PasswordReset]),
    // RatelimiterModule — гвард лимитов на login() (брутфорс по email)
    RatelimiterModule,
    // OutboxModule — будильник Курьера после коммита «письма» сброса
    // (само «письмо» user.password.reset Курьер и доставит)
    OutboxModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}

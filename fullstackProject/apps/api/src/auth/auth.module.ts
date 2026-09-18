import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
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
    // rabbitMqModule — чтобы инжектить AmqpConnection («письмо» сброса пароля)
    TypeOrmModule.forFeature([PasswordReset]),
    rabbitMqModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}

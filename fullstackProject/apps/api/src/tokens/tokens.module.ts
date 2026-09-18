import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from './refresh-token.entity';
import { TokensService } from './tokens.service';

/**
 * Выдача/ротация пары токенов. JwtModule переезжает сюда из AuthModule:
 * TokensService подписывает пары, а AuthModule реэкспортом получает
 * JwtService для стратегии — без цикла модулей (users тоже импортирует нас).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([RefreshToken]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET', 'dev-cine-secret'),
        signOptions: { expiresIn: '2h' },
      }),
    }),
  ],
  providers: [TokensService],
  exports: [TokensService, JwtModule],
})
export class TokensModule {}

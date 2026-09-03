import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(
          config.get<string>('REDIS_URL', 'redis://localhost:6379'),
          { maxRetriesPerRequest: 1 },
        ),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}

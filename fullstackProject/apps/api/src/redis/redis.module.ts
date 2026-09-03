import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

export const REDIS_CLIENT = 'REDIS_CLIENT';

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

import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';
import { RedisService } from './redis.service';

/**
 * Закрывает клиент при shutdown: без этого открытый сокет ioredis держал
 * процесс живым после app.close() — проявилось в live-int спеках
 * (jest не выходил, CI-джоба умирала по таймауту).
 */
@Injectable()
export class RedisClientShutdown implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  onModuleDestroy(): void {
    // disconnect, а не quit: не ждём ответа сервера — закрываемся быстро
    // и без исключений на уже отвалившемся соединении
    this.client.disconnect();
  }
}

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
    RedisClientShutdown,
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}

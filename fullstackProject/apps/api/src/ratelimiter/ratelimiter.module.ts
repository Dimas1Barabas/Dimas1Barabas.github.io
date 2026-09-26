import { Module } from '@nestjs/common';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimiterClient } from './ratelimiter.client';

/**
 * Один экземпляр клиента на всё приложение: BookingsModule и AuthModule
 * импортируют этот модуль — ленивое gRPC-соединение общее.
 */
@Module({
  providers: [RateLimiterClient, RateLimitGuard],
  exports: [RateLimiterClient, RateLimitGuard],
})
export class RatelimiterModule {}

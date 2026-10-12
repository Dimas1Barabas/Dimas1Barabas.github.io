import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { RATE_LIMITED_ACTION } from '../ratelimiter/rate-limited.decorator';
import { RateLimiterClient } from '../ratelimiter/ratelimiter.client';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Маршрут инжеста: публичный (анонимный витринный трафик шлёт aid
 * из localStorage) и лимитируемый на aid — метаданные гвардов здесь,
 * HTTP-поведение в test/analytics.int.spec.ts.
 */
describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let reflector: Reflector;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        AnalyticsService,
        { provide: AmqpConnection, useValue: { publish: jest.fn() } },
        // @UseGuards(RateLimitGuard) инстанцируется при компиляции модуля
        { provide: RateLimiterClient, useValue: { check: jest.fn() } },
      ],
    }).compile();
    controller = moduleRef.get(AnalyticsController);
    reflector = moduleRef.get(Reflector);
  });

  it('ingest помечен @Public() — анонимный трафик проходит', () => {
    const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      controller.constructor,
      controller.ingest,
    ]);
    expect(isPublic).toBe(true);
  });

  it('ingest лимитируется действием analytics.ingest', () => {
    const action = reflector.getAllAndOverride<string>(RATE_LIMITED_ACTION, [
      controller.ingest,
      controller.constructor,
    ]);
    expect(action).toBe('analytics.ingest');
  });
});

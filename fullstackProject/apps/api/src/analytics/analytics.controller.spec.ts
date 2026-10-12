import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RATE_LIMITED_ACTION } from '../ratelimiter/rate-limited.decorator';
import { RateLimiterClient } from '../ratelimiter/ratelimiter.client';
import { AnalyticsInsightsClient } from './analytics-insights.client';
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
  let moduleRef: TestingModule;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        AnalyticsService,
        { provide: AmqpConnection, useValue: { publish: jest.fn() } },
        // @UseGuards(RateLimitGuard) инстанцируется при компиляции модуля
        { provide: RateLimiterClient, useValue: { check: jest.fn() } },
        { provide: AnalyticsInsightsClient, useValue: { insights: jest.fn() } },
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

  it('insights — только админам', () => {
    const roles = reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      controller.showcase,
      controller.constructor,
    ]);
    expect(roles).toEqual(['admin']);
  });

  it('showcase: Аналитик жив — available:true с его данными', async () => {
    const client = moduleRef.get(AnalyticsInsightsClient) as {
      insights: jest.Mock;
    };
    client.insights.mockResolvedValueOnce({ funnel: [{ step: 'paid', count: 3 }] });

    await expect(controller.showcase()).resolves.toEqual({
      available: true,
      data: { funnel: [{ step: 'paid', count: 3 }] },
    });
  });

  it('showcase: Аналитик недоступен — available:false, не 500', async () => {
    const client = moduleRef.get(AnalyticsInsightsClient) as {
      insights: jest.Mock;
    };
    client.insights.mockResolvedValueOnce(null);

    await expect(controller.showcase()).resolves.toEqual({ available: false });
  });
});

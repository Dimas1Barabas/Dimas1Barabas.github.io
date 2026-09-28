import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Витрина метрик: эндпоинт публичный (скрейпер ходит без JWT) и отдаёт
 * exposition-текст реестра.
 */

describe('MetricsController', () => {
  let controller: MetricsController;
  let service: MetricsService;
  let reflector: Reflector;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsService],
    }).compile();

    controller = moduleRef.get(MetricsController);
    service = moduleRef.get(MetricsService);
    reflector = moduleRef.get(Reflector);
  });

  it('отдаёт текст с метриками API', async () => {
    service.httpDuration.labels('GET', '/api/movies', '200').observe(0.02);

    const text = await controller.expose();
    expect(text).toContain('cine_api_http_request_duration_seconds');
  });

  it('помечен @Public() — JwtAuthGuard его пропускает', () => {
    const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      controller.constructor,
      controller.expose,
    ]);
    expect(isPublic).toBe(true);
  });
});

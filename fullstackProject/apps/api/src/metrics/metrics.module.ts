import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Метрики — сквозная забота, поэтому модуль @Global: MetricsService
 * доступен любому модулю (доменные счётчики — следующий этап), а
 * интерцептор вешается на все HTTP-роуты через APP_INTERCEPTOR.
 */
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}

import { Module } from '@nestjs/common';

import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { RatelimiterModule } from '../ratelimiter/ratelimiter.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Инжест поведенческой аналитики: тонкая труба веб → брокер.
 * Своих таблиц нет — агрегаты копит Go-сервис «Аналитик»
 * (services/analytics-service), этот модуль только валидирует
 * и публикует.
 */
@Module({
  imports: [RatelimiterModule, rabbitMqModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}

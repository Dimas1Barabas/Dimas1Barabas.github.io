import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/public.decorator';
import { RateLimited } from '../ratelimiter/rate-limited.decorator';
import { RateLimitGuard } from '../ratelimiter/rate-limit.guard';
import { AnalyticsService } from './analytics.service';
import { IngestAnalyticsDto } from './dto/ingest.dto';

class IngestResultDto {
  @ApiProperty({ example: 12, description: 'сколько событий принято в очередь' })
  accepted!: number;
}

/**
 * Поведенческая аналитика — входной поток событий с веба. Публичный:
 * события шлёт и анонимный витринный трафик (aid из localStorage).
 */
@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * Приём батча событий: 202 — приняли в брокер, агрегирует Аналитик.
   * Клиент шлёт sendBeacon'ом на уходе со страницы, ответ не читает.
   */
  @Post('events')
  @HttpCode(202)
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimited('analytics.ingest')
  @ApiOperation({
    summary: 'Принять батч событий поведения (web → Аналитик)',
    description:
      'Накопленные на клиенте события (до 50 за батч) уходят в брокер ' +
      'Routing Key analytics.event — агрегирует Go-сервис «Аналитик». ' +
      'Лимит Привратника — на aid из конверта, не на IP.',
  })
  ingest(@Body() dto: IngestAnalyticsDto): IngestResultDto {
    return this.analytics.ingest(dto);
  }
}

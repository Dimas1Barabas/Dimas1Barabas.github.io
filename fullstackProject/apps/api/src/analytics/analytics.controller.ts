import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { RateLimited } from '../ratelimiter/rate-limited.decorator';
import { RateLimitGuard } from '../ratelimiter/rate-limit.guard';
import { AnalyticsInsightsClient } from './analytics-insights.client';
import { AnalyticsService } from './analytics.service';
import { IngestAnalyticsDto } from './dto/ingest.dto';

class IngestResultDto {
  @ApiProperty({ example: 12, description: 'сколько событий принято в очередь' })
  accepted!: number;
}

/** конверт витрины: без Аналитика — available:false, страница покажет заглушку */
class InsightsResultDto {
  @ApiProperty({ example: true })
  available!: boolean;
  @ApiProperty({
    required: false,
    description: 'витрина «Поведение» (funnel, movies, pages, seats, modal)',
  })
  data?: unknown;
}

/**
 * Поведенческая аналитика — входной поток событий с веба. Публичный:
 * события шлёт и анонимный витринный трафик (aid из localStorage).
 */
@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly insights: AnalyticsInsightsClient,
  ) {}

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

  /**
   * Витрина «Поведение» для админ-страницы: прокси до /insights Аналитика.
   * Сервис опционален — недоступность отдаём available:false, не 500.
   */
  @Get('insights')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Витрина «Поведение» (прокси до Go-Аналитика)',
    description:
      'Воронка пути зрителя, интерес к фильмам против броней, страницы ' +
      'со временем пребывания, тепловая карта мест, время в модалке ' +
      'по глубине. Аналитик недоступен — available:false вместо ошибки.',
  })
  @ApiOkResponse({ description: 'available:false — Аналитик не отвечает' })
  async showcase(): Promise<InsightsResultDto> {
    const data = await this.insights.insights();
    return data === null ? { available: false } : { available: true, data };
  }
}

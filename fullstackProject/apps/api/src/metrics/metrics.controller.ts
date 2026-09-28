import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * Витрина метрик для Prometheus. Публичный эндпоинт: скрейпер ходит
 * без JWT, а в самих метриках нет персональных данных — только
 * агрегаты по маршрутам.
 */
@Public()
@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({
    summary: 'Метрики Prometheus',
    description: 'Exposition-формат v0.0.4: HTTP-гистограммы + process/nodejs-метрики',
  })
  async expose(): Promise<string> {
    return this.metrics.metrics();
  }
}

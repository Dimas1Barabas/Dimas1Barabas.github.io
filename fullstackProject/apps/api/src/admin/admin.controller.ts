import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { AdminStatsService } from './admin-stats.service';
import { AdminStatsResultDto } from './dto/admin-stats.dto';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminStats: AdminStatsService) {}

  /** аналитика кинотеатра — только администратору */
  @Roles('admin')
  @Get('stats')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Аналитика кинотеатра (админ-дашборд)',
    description:
      'Сводка KPI (выручка, средний чек, проданные места), счётчики по ' +
      'статусам, топ-5 фильмов, заполняемость предстоящих сеансов и ' +
      'выручка по дням за 2 недели. Конверт-обёртка: ' +
      '`{ source: "cache" | "db", data }` — источник виден фронту ' +
      'бейджем «из кэша» (Redis, TTL 30 c).',
  })
  @ApiOkResponse({ type: AdminStatsResultDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  stats() {
    return this.adminStats.getStats();
  }
}

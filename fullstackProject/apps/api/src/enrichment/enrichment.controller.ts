import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { EnrichmentService } from './enrichment.service';

/**
 * Эндпоинты внешних метаданных (этап 37). Оба админские: синк — действие
 * человека из админки, статус — диагностика (гейт/цепь/счётчик). Витрина
 * внешний блок получает внутри обычных GET /movies — decorate в
 * MoviesController, отдельных публичных ручек не нужно.
 */
@ApiTags('movies')
@Controller()
export class EnrichmentController {
  constructor(private readonly enrichment: EnrichmentService) {}

  /** синк одного фильма со справочником */
  @Roles('admin')
  @Post('movies/:id/external-sync')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Синк внешних метаданных фильма',
    description:
      'Только админ (роль из JWT). Ищет фильм во внешнем справочнике по ' +
      'названию каталога: нашёл — обновляет строку external_movies и ' +
      'переливает постер в S3, если у фильма нет своего. Не нашёл — ' +
      '`matched:false` (это не ошибка, строка не пишется). Справочник ' +
      'недоступен (ретраи исчерпаны или breaker открыт) — 502, модуль ' +
      'выключен (нет EXTERNAL_MOVIES_URL) — 503.',
  })
  @ApiOkResponse({
    description: 'Результат синка: { movieId, matched, external?, posterSynced }',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  @ApiBadGatewayResponse({ description: 'Справочник недоступен (ретраи/breaker)' })
  sync(@Param('id', ParseUUIDPipe) id: string) {
    return this.enrichment.syncMovie(id);
  }

  /** витрина состояния модуля: гейт, цепь breaker'а, размер внешнего блока */
  @Roles('admin')
  @Get('admin/external-movies/status')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Состояние модуля внешних метаданных',
    description:
      'Только админ. enabled — есть ли EXTERNAL_MOVIES_URL; breaker — ' +
      'state (closed/open/half-open) и счёт неудач подряд; ' +
      'enrichedMovies — сколько фильмов каталога несут внешний блок ' +
      '(null — БД молчит, витрина не падает).',
  })
  @ApiOkResponse({
    description: '{ enabled, breaker: { state, failures }, enrichedMovies }',
  })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  status() {
    return this.enrichment.status();
  }
}

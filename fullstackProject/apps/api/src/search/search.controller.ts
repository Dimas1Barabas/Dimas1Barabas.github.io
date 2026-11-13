import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchSuggestionDto } from './suggestion.dto';
import { SearchService } from './search.service';

/** витрина: подсказки поиска доступны без авторизации */
@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Public()
  @Get('movies')
  @ApiOperation({
    summary: 'Подсказки поиска афиши',
    description:
      'Полнотекстовый поиск Meilisearch по названию/описанию/жанру ' +
      '(терпит опечатки, ранжирует по названию). Ответ-обёртка: ' +
      '`{ source: "meilisearch" | "db", data: SearchSuggestionDto[] }` — ' +
      'db значит фолбэк: движка нет или он молчит, подсказки посчитаны ' +
      'подстрокой в Postgres. Пустой запрос (после трима) — пустой список.',
  })
  @ApiOkResponse({
    description: 'Подсказки для выпадающего списка витрины',
    type: SearchSuggestionDto,
    isArray: true,
  })
  movies(@Query() dto: SearchQueryDto) {
    return this.search.suggest(dto.q, dto.limit ?? 8);
  }
}

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { MovieDto } from './movie.entity';
import { CreateMovieDto } from './dto/create-movie.dto';
import { MoviesService } from './movies.service';

@ApiTags('movies')
@Controller('movies')
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  /** витрина: каталог доступен без авторизации */
  @Public()
  @Get()
  @ApiOperation({
    summary: 'Каталог фильмов с расписанием',
    description:
      'Афиша, отсортированная по ближайшему будущему сеансу. Ответ-обёртка: ' +
      '`{ source: "cache" | "db", data: MovieDto[] }` — источник виден во ' +
      'фронте бейджем «из кэша» (Redis, TTL 60 c).',
  })
  @ApiOkResponse({ description: 'Каталог с сеансами и рейтингами' })
  findAll() {
    return this.movies.findAll();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Фильм по id' })
  @ApiOkResponse({ type: MovieDto })
  @ApiNotFoundResponse({ description: 'Фильм не найден' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.movies.findOne(id);
  }

  /** новый сеанс — только администратору */
  @Roles('admin')
  @Post()
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Добавить фильм в афишу',
    description: 'Только админ (роль из JWT). Фильм создаётся сразу с сеансами.',
  })
  @ApiCreatedResponse({ type: MovieDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  create(@Body() dto: CreateMovieDto) {
    return this.movies.create(dto);
  }
}

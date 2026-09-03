import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { MoviesService } from './movies.service';

@Controller('movies')
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  /** Список фильмов; ответ помечает источник — Redis или Postgres */
  @Get()
  findAll() {
    return this.movies.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.movies.findOne(id);
  }
}

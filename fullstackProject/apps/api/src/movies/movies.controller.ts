import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CreateMovieDto } from './dto/create-movie.dto';
import { MoviesService } from './movies.service';

@Controller('movies')
export class MoviesController {
  constructor(private readonly movies: MoviesService) {}

  /** витрина: каталог доступен без авторизации */
  @Public()
  @Get()
  findAll() {
    return this.movies.findAll();
  }

  @Public()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.movies.findOne(id);
  }

  /** новый сеанс — только администратору */
  @Roles('admin')
  @Post()
  @HttpCode(201)
  create(@Body() dto: CreateMovieDto) {
    return this.movies.create(dto);
  }
}

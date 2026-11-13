import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostersModule } from '../posters/posters.module';
import { SearchModule } from '../search/search.module';
import { Movie } from './movie.entity';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';
import { Session } from './session.entity';

@Module({
  // PostersModule — постеры фильмов: GET-раздача с кэшем и админские
  // upload/delete живут в MoviesController (эндпоинты /movies/:id/poster);
  // SearchModule — новый фильм уходит в индекс подсказок (этап 30)
  imports: [
    TypeOrmModule.forFeature([Movie, Session]),
    PostersModule,
    SearchModule,
  ],
  controllers: [MoviesController],
  providers: [MoviesService],
  // MoviesService — кандидаты афиши для топа рекомендаций:
  // RecommendationsModule импортирует нас и инжектит сервис.
  // Без экспорта весь AppModule не собирается: инжектор требует, чтобы
  // сервис был виден через exports импортированного модуля (поймано
  // live-int спеками — первым полным in-process compile приложения;
  // int-уровень это маскировал overrideProvider'ом MoviesService).
  exports: [TypeOrmModule, MoviesService],
})
export class MoviesModule {}

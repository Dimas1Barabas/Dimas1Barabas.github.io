import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from './movie.entity';
import { MoviesController } from './movies.controller';
import { MoviesService } from './movies.service';
import { Session } from './session.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Movie, Session])],
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

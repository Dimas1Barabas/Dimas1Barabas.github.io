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
  exports: [TypeOrmModule],
})
export class MoviesModule {}

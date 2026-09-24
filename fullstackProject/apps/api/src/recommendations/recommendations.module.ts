import { Module } from '@nestjs/common';
import { MoviesModule } from '../movies/movies.module';
import { rabbitMqModule } from '../rabbit/rabbitmq.config';
import { RecommendationsClient } from './recommendations.client';
import { RecommendationsConsumer } from './recommendations.consumer';
import { RecommendationsController } from './recommendations.controller';
import { RecommendationsService } from './recommendations.service';

@Module({
  // MoviesModule — кандидаты афиши для топа; rabbitMqModule — консьюмер
  // сигналов, гасящий кэш (издатели сигналов живут в bookings/reviews)
  imports: [MoviesModule, rabbitMqModule],
  controllers: [RecommendationsController],
  providers: [RecommendationsClient, RecommendationsService, RecommendationsConsumer],
  exports: [RecommendationsService],
})
export class RecommendationsModule {}

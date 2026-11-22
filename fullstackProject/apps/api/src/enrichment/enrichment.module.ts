import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { PostersModule } from '../posters/posters.module';
import { EnrichmentConfig, enrichmentConfigFromEnv } from './enrichment.config';
import { EnrichmentController } from './enrichment.controller';
import { EnrichmentService } from './enrichment.service';
import { ExternalMovie } from './external-movie.entity';
import { ExternalMoviesClient } from './external-movies.client';

/**
 * Внешние метаданные афиши (этап 37). Клиент строится из env на сборке
 * модуля — как стор постеров и Meilisearch: EXTERNAL_MOVIES_URL есть —
 * живой HTTP-клиент с breaker'ом, нет — null: синк отвечает 503, каталог
 * живёт без внешнего блока, стенд не замечает этапа.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ExternalMovie, Movie]), PostersModule],
  controllers: [EnrichmentController],
  providers: [
    {
      provide: ExternalMoviesClient,
      useFactory: () => {
        const config: EnrichmentConfig | null = enrichmentConfigFromEnv();
        return config ? new ExternalMoviesClient(config) : null;
      },
    },
    EnrichmentService,
  ],
  exports: [EnrichmentService],
})
export class EnrichmentModule {}

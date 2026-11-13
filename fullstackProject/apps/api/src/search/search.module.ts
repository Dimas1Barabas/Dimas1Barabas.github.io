import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { MeiliStore } from './meili.store';
import { searchConfigFromEnv } from './search.config';
import { SearchService } from './search.service';

/**
 * Полнотекстовый поиск афиши (этап 30). Стор строится из env на сборке
 * модуля: MEILI_HOST есть — живой клиент Meilisearch (в стенде — сервис
 * из docker compose), нет — null-стор: поиск деградирует на ILIKE-фолбэк
 * в Postgres, стенд без движка жив. Индексацию и подсказки ведёт
 * SearchService; MoviesModule и ReviewsModule импортируют его для
 * хуков «фильм создан / рейтинг изменился».
 */
@Module({
  imports: [TypeOrmModule.forFeature([Movie])],
  providers: [
    {
      provide: MeiliStore,
      useFactory: () => {
        const config = searchConfigFromEnv();
        return config ? new MeiliStore(config) : null;
      },
    },
    SearchService,
  ],
  exports: [SearchService],
})
export class SearchModule {}

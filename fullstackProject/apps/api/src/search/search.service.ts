import { Inject, Injectable } from '@nestjs/common';
import { MeiliStore } from './meili.store';

/**
 * Домен поиска афиши. Деградация — принцип этапа: движка нет или он
 * молчит → подсказки считаются фолбэком в Postgres (ILIKE), витрина
 * поиск не теряет. Стенд без MEILI_HOST жив ровно как стенд с упавшим
 * Meilisearch.
 */
@Injectable()
export class SearchService {
  // токен задан явно: тип-юнион «MeiliStore | null» не попадает в
  // design:paramtypes (TS не сериализует юнионы) — без @Inject Nest
  // видел undefined и падал на буте приложения (урок posters, fc19c4f0)
  constructor(@Inject(MeiliStore) private readonly store: MeiliStore | null) {}

  /** настроен ли движок (для самопроверок) */
  get enabled(): boolean {
    return this.store !== null;
  }
}

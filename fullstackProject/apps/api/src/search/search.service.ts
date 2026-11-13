import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Movie, MovieDto } from '../movies/movie.entity';
import { MeiliStore, MovieDoc } from './meili.store';

/** документ подсказки из строки каталога */
function toMovieDoc(movie: Movie): MovieDoc {
  return {
    id: movie.id,
    title: movie.title,
    description: movie.description,
    genre: movie.genre,
    genreIcon: movie.genreIcon,
    hue: movie.hue,
    ratingAvg: movie.ratingAvg ?? 0,
  };
}

/**
 * Домен поиска афиши. Деградация — принцип этапа: движка нет или он
 * молчит → подсказки считаются фолбэком в Postgres (ILIKE), витрина
 * поиск не теряет. Стенд без MEILI_HOST жив ровно как стенд с упавшим
 * Meilisearch: бут и хуки индексации глотают ошибки ворнингом.
 */
@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    // токен задан явно: тип-юнион «MeiliStore | null» не попадает в
    // design:paramtypes (TS не сериализует юнионы) — без @Inject Nest
    // видел undefined и падал на буте приложения (урок posters, fc19c4f0)
    @Inject(MeiliStore) private readonly store: MeiliStore | null,
    @InjectRepository(Movie) private readonly movies: Repository<Movie>,
  ) {}

  /** настроен ли движок (для самопроверок) */
  get enabled(): boolean {
    return this.store !== null;
  }

  /**
   * Пересборка индекса при старте. OnApplicationBootstrap, а не
   * OnModuleInit: фаза бута ПОСЛЕ init-хуков всех модулей — посев
   * каталога MoviesService уже прошёл, индексируем полный каталог.
   * Полная пересборка (delete-all + add), а не upsert: посев после
   * TRUNCATE создаёт фильмы с новыми uuid, upsert оставил бы призраков
   * прошлой эпохи в подсказках. Идемпотентна — live-харнесс зовёт
   * повторно после собственного пересева.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.ensureIndex();
      const rows = await this.movies.find();
      await this.store.rebuild(rows.map(toMovieDoc));
      this.logger.log(`Индекс пересобран: ${rows.length} фильмов`);
    } catch (err) {
      this.logger.warn(
        `Бут индекса поиска не удался: ${String(err)} — поиск уйдёт на фолбэк`,
      );
    }
  }

  /** новый фильм (админ) — сразу в индексе подсказок; движок молчит —
   *  ворнинг, создание фильма не отменяется */
  async indexMovie(dto: MovieDto): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.upsert({
        id: dto.id,
        title: dto.title,
        description: dto.description,
        genre: dto.genre,
        genreIcon: dto.genreIcon,
        hue: dto.hue,
        ratingAvg: dto.ratingAvg ?? 0,
      });
    } catch (err) {
      this.logger.warn(`Индексация фильма ${dto.id} не удалась: ${String(err)}`);
    }
  }

  /** рейтинг фильма изменился (отзыв создан/удалён) — обновить документ,
   *  чтобы подсказки не показывали вчерашнюю оценку */
  async reindexMovie(id: string): Promise<void> {
    if (!this.store) return;
    try {
      const movie = await this.movies.findOneBy({ id });
      if (!movie) return;
      await this.store.upsert(toMovieDoc(movie));
    } catch (err) {
      this.logger.warn(`Переиндексация фильма ${id} не удалась: ${String(err)}`);
    }
  }
}

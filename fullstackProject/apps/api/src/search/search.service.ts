import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Movie, MovieDto } from '../movies/movie.entity';
import { MeiliStore, MovieDoc } from './meili.store';
import { SearchSuggestionDto, docToSuggestion } from './suggestion.dto';

/** откуда посчитаны подсказки: живой движок или фолбэк-запрос в базе */
export type SearchSource = 'meilisearch' | 'db';

/** % и _ — метасимволы ILIKE: прячем, чтобы искались буквально */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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

  /**
   * Подсказки витрины. Живой движок — полнотекстовый поиск Meilisearch
   * (опечатки, словоформы, ранжирование по названию); его нет или он
   * молчит — ILIKE-фолбэк в Postgres: витрина поиск не теряет.
   */
  async suggest(
    q: string,
    limit = 8,
  ): Promise<{ source: SearchSource; data: SearchSuggestionDto[] }> {
    const query = q.trim();
    if (!query) {
      // пустое — движок не беспокоим, но источник честный
      return { source: this.store ? 'meilisearch' : 'db', data: [] };
    }
    if (this.store) {
      try {
        const docs = await this.store.search(query, limit);
        return { source: 'meilisearch', data: docs.map(docToSuggestion) };
      } catch (err) {
        this.logger.warn(
          `Поиск в движке не удался: ${String(err)} — подсказки на фолбэке`,
        );
      }
    }
    return { source: 'db', data: await this.searchInDb(query, limit) };
  }

  /** фолбэк: подстрока в названии/описании/жанре, сверху — с высоким
   *  рейтингом; тот же контракт подсказок, что у движка */
  private async searchInDb(
    q: string,
    limit: number,
  ): Promise<SearchSuggestionDto[]> {
    const rows = await this.movies
      .createQueryBuilder('movie')
      .where(
        'movie.title ILIKE :q OR movie.description ILIKE :q OR movie.genre ILIKE :q',
        { q: `%${escapeLike(q)}%` },
      )
      .orderBy('movie.rating_avg', 'DESC')
      .addOrderBy('movie.title', 'ASC')
      .take(limit)
      .getMany();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      genre: row.genre,
      genreIcon: row.genreIcon,
      hue: row.hue,
      ratingAvg: row.ratingAvg ?? 0,
    }));
  }
}

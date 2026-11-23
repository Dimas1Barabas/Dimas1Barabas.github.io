import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Movie } from '../movies/movie.entity';
import { PostersService } from '../posters/posters.service';
import { ExternalMovie, toExternalInfoDto } from './external-movie.entity';
import {
  ExternalMoviesClient,
  ExternalMoviesUnavailableError,
} from './external-movies.client';

/** результат синка одного фильма */
export interface SyncResult {
  movieId: string;
  /** справочник знает фильм — строка обновлена */
  matched: boolean;
  /** matched=false: почему (пока единственная причина — не знает) */
  reason?: 'not_found';
  external?: ReturnType<typeof toExternalInfoDto>;
  /** постер перезалит в S3 этим синком (false — был свой/не скачался) */
  posterSynced: boolean;
}

/** витрина состояния модуля для админки */
export interface EnrichmentStatus {
  enabled: boolean;
  breaker: { state: string; failures: number };
  /** сколько фильмов каталога несут внешний блок (null — БД молчит) */
  enrichedMovies: number | null;
}

/**
 * Домен внешних метаданных афиши (этап 37): синк фильма со справочником
 * и декорирование каталога. Деградация — принцип этапа, как у постеров
 * и поиска: модуль выключен → синк 503, каталог без external; справочник
 * лежит → синк 502 с причиной, каталог не задет: decorate глотает ошибки
 * чтения и отдаёт карточки как были.
 */
@Injectable()
export class EnrichmentService implements OnModuleInit {
  private readonly logger = new Logger(EnrichmentService.name);

  constructor(
    // токен задан явно: юнион «ExternalMoviesClient | null» не попадает
    // в design:paramtypes — урок posters/search (fc19c4f0)
    @Inject(ExternalMoviesClient)
    private readonly client: ExternalMoviesClient | null,
    @InjectRepository(ExternalMovie)
    private readonly rows: Repository<ExternalMovie>,
    @InjectRepository(Movie) private readonly movies: Repository<Movie>,
    private readonly posters: PostersService,
  ) {}

  /** прогрев коннекта к справочнику до первого синка (см. клиент.warmup) */
  onModuleInit(): void {
    this.client?.warmup();
  }

  /** настроен ли справочник (нет EXTERNAL_MOVIES_URL — модуль спит) */
  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Синк фильма: поиск по названию каталога → upsert строки → постер,
   * если у фильма ещё нет своего. «Справочник не знает фильм» — не ошибка:
   * matched:false, строка не пишется. Недоступность справочника — 502,
   * выключенный модуль — 503.
   */
  async syncMovie(movieId: string): Promise<SyncResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'модуль внешних метаданных выключен: нет EXTERNAL_MOVIES_URL',
      );
    }
    // 404 до похода наружу: синкать несуществующий фильм нечего
    const movie = await this.movies.findOneByOrFail({ id: movieId });

    let record;
    try {
      record = await this.client.findByTitle(movie.title);
    } catch (err) {
      if (err instanceof ExternalMoviesUnavailableError) {
        throw new BadGatewayException(err.message);
      }
      throw err;
    }
    if (!record) {
      return { movieId, matched: false, reason: 'not_found', posterSynced: false };
    }

    const row = await this.rows.save(
      this.rows.create({
        movieId,
        rating: record.rating,
        votes: record.votes,
        year: record.year,
        genres: record.genres,
        country: record.country,
        director: record.director,
        actors: record.actors,
        ageRating: record.ageRating,
        trailerUrl: record.trailerUrl,
        sourcePosterUrl: record.posterUrl,
        syncedAt: new Date(),
      }),
    );

    const posterSynced = await this.syncPoster(movieId, record.posterUrl);
    this.logger.log(
      `синк «${movie.title}»: рейтинг ${record.rating}, постер ${posterSynced ? 'залит' : 'не тронут'}`,
    );
    return { movieId, matched: true, external: toExternalInfoDto(row), posterSynced };
  }

  /**
   * Постер справочника → S3, ТОЛЬКО если своего нет: ручная загрузка
   * админа (этап 29) приоритетнее внешней картинки. Неудача — не неудача
   * синка: витрина останется на градиентном фолбэке.
   */
  private async syncPoster(movieId: string, posterUrl: string): Promise<boolean> {
    if (!this.client || !posterUrl || !this.posters.enabled) return false;
    try {
      const existing = await this.posters.poster(movieId);
      if (existing) return false; // свой постер не перетираем
      const poster = await this.client.fetchPoster(posterUrl);
      if (!poster) return false;
      await this.posters.upload(movieId, poster.buffer, poster.contentType);
      return true;
    } catch (err) {
      this.logger.warn(`постер внешнего синка ${movieId} не залит: ${String(err)}`);
      return false;
    }
  }

  /**
   * Декорирование каталога: одним запросом поднимаем строки по In(ids) и
   * приклеиваем external тем, у кого она есть. Ошибка чтения — деградация:
   * витрина получает карточки без внешнего блока, а не 500. Вызывается
   * ПОВЕРХ кэша Redis (в кэше лежит базовый DTO), поэтому синк ничего
   * не инвалидирует: внешний блок всегда свежий из своей таблицы.
   */
  async decorate<T extends { id: string }>(dtos: T[]): Promise<(T & { external?: unknown })[]> {
    if (!dtos.length) return dtos;
    let rows: ExternalMovie[];
    try {
      rows = await this.rows.find({
        where: { movieId: In(dtos.map((d) => d.id)) },
      });
    } catch (err) {
      this.logger.warn(
        `чтение внешних метаданных не удалось: ${String(err)} — каталог без external`,
      );
      return dtos;
    }
    const byMovie = new Map(rows.map((r) => [r.movieId, toExternalInfoDto(r)]));
    return dtos.map((d) => {
      const external = byMovie.get(d.id);
      return external ? { ...d, external } : d;
    });
  }

  /** состояние модуля: гейт, цепь breaker'а, размер внешнего блока каталога */
  async status(): Promise<EnrichmentStatus> {
    return {
      enabled: this.enabled,
      breaker: {
        state: this.client?.breakerState ?? 'off',
        failures: this.client?.breaker.failureCount ?? 0,
      },
      enrichedMovies: await this.rows.count().catch(() => null),
    };
  }
}

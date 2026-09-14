import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { Movie, MovieDto, toMovieDto } from './movie.entity';
import { MOVIE_SEEDS } from './movie.seeds';

// v3: форма ответа сменилась (ratingAvg/ratingCount у фильмов) — старые
// значения не должны доживать свой TTL в новом коде
export const MOVIES_KEY = 'movies:all:v3';
export const movieKey = (id: string): string => `movie:v3:${id}`;
const MOVIES_TTL_SEC = 60;

@Injectable()
export class MoviesService implements OnModuleInit {
  private readonly logger = new Logger(MoviesService.name);

  constructor(
    @InjectRepository(Movie) private readonly movies: Repository<Movie>,
    private readonly redis: RedisService,
  ) {}

  /** При первом старте с пустой БД — сеем стартовые фильмы (с сеансами) */
  async onModuleInit(): Promise<void> {
    const count = await this.movies.count();
    if (count > 0) return;
    const seeds = MOVIE_SEEDS.map((s) => this.movies.create(s));
    await this.movies.save(seeds); // cascade разложит сеансы
    const sessionCount = seeds.reduce((acc, m) => acc + m.sessions.length, 0);
    this.logger.log(
      `Посеял ${seeds.length} фильмов, ${sessionCount} сеансов`,
    );
  }

  async findAll(): Promise<{ source: 'cache' | 'db'; data: MovieDto[] }> {
    const { value, source } = await this.redis.withCache<MovieDto[]>(
      MOVIES_KEY,
      MOVIES_TTL_SEC,
      async () => {
        const rows = await this.movies.find({
          relations: { sessions: true },
        });
        // find не умеет order по агрегату relation — сортируем в JS
        // по ближайшему сеансу (все прошедшие — по последнему прошедшему)
        return rows
          .map((row) => ({
            row,
            nearest: nearestStart(row),
          }))
          .sort((a, b) => a.nearest - b.nearest)
          .map(({ row }) => toMovieDto(row));
      },
    );
    return { source, data: value };
  }

  async findOne(id: string): Promise<MovieDto> {
    const { value } = await this.redis.withCache<MovieDto>(
      movieKey(id),
      MOVIES_TTL_SEC,
      async () => {
        const movie = await this.movies.findOneOrFail({
          where: { id },
          relations: { sessions: true },
        });
        return toMovieDto(movie);
      },
    );
    return value;
  }

  /** новый фильм с сеансами в афишу (админ); список покидает кэш сразу */
  async create(input: {
    title: string;
    description: string;
    genre: string;
    genreIcon: string;
    durationMin: number;
    priceRub: number;
    hue: number;
    sessions: { hall: string; startsAt: string }[];
  }): Promise<MovieDto> {
    const movie = await this.movies.save(
      this.movies.create({
        ...input,
        sessions: input.sessions.map((s) => ({
          hall: s.hall,
          startsAt: new Date(s.startsAt),
        })),
      }),
    );
    await this.invalidate(movie.id);
    return toMovieDto(movie);
  }

  /**
   * Сброс кэша (новый фильм, изменение рейтинга). movieId — сбросить
   * и карточку фильма, иначе она доживёт свой TTL со старым рейтингом.
   */
  async invalidate(movieId?: string): Promise<void> {
    const keys = movieId ? [MOVIES_KEY, movieKey(movieId)] : [MOVIES_KEY];
    await this.redis.del(...keys);
  }
}

/** метка ближайшего будущего сеанса; все прошли — последний прошедший */
function nearestStart(movie: Movie, now = Date.now()): number {
  const times = (movie.sessions ?? []).map((s) => s.startsAt.getTime());
  if (!times.length) return Number.POSITIVE_INFINITY;
  const upcoming = times.filter((t) => t >= now);
  return upcoming.length ? Math.min(...upcoming) : Math.max(...times);
}

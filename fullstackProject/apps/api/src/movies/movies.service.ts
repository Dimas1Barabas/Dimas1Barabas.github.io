import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { Movie, MovieDto, toMovieDto } from './movie.entity';
import { MOVIE_SEEDS } from './movie.seeds';

const MOVIES_KEY = 'movies:all';
const MOVIES_TTL_SEC = 60;

@Injectable()
export class MoviesService implements OnModuleInit {
  private readonly logger = new Logger(MoviesService.name);

  constructor(
    @InjectRepository(Movie) private readonly movies: Repository<Movie>,
    private readonly redis: RedisService,
  ) {}

  /** При первом старте с пустой БД — сеем стартовые фильмы */
  async onModuleInit(): Promise<void> {
    const count = await this.movies.count();
    if (count > 0) return;
    const seeds = MOVIE_SEEDS.map((s) => this.movies.create(s));
    await this.movies.save(seeds);
    this.logger.log(`Посеял ${seeds.length} фильмов`);
  }

  async findAll(): Promise<{ source: 'cache' | 'db'; data: MovieDto[] }> {
    const { value, source } = await this.redis.withCache<MovieDto[]>(
      MOVIES_KEY,
      MOVIES_TTL_SEC,
      async () => {
        const rows = await this.movies.find({ order: { sessionAt: 'ASC' } });
        return rows.map(toMovieDto);
      },
    );
    return { source, data: value };
  }

  async findOne(id: string): Promise<MovieDto> {
    const { value } = await this.redis.withCache<MovieDto>(
      `movie:${id}`,
      MOVIES_TTL_SEC,
      async () => {
        const movie = await this.movies.findOneByOrFail({ id });
        return toMovieDto(movie);
      },
    );
    return value;
  }

  /** новый сеанс в афишу (админ); список фильмов покидает кэш сразу */
  async create(input: {
    title: string;
    description: string;
    genre: string;
    genreIcon: string;
    durationMin: number;
    priceRub: number;
    hue: number;
    sessionAt: string;
  }): Promise<MovieDto> {
    const movie = await this.movies.save(
      this.movies.create({ ...input, sessionAt: new Date(input.sessionAt) }),
    );
    await this.invalidate();
    return toMovieDto(movie);
  }

  /** Сброс кэша (например, после пересева) */
  async invalidate(): Promise<void> {
    await this.redis.del(MOVIES_KEY);
  }
}

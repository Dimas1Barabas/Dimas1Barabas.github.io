import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { Booking } from '../bookings/booking.entity';
import { Movie } from '../movies/movie.entity';
import { MOVIES_KEY, movieKey } from '../movies/movies.service';
import { RedisService } from '../redis/redis.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { Review, ReviewDto, toReviewDto } from './review.entity';

/** unique_violation в Postgres */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Review)
    private readonly reviews: Repository<Review>,
    @InjectRepository(Movie)
    private readonly movies: Repository<Movie>,
    @InjectRepository(Booking)
    private readonly bookings: Repository<Booking>,
    private readonly redis: RedisService,
  ) {}

  /** отзывы фильма, свежие сверху; автор нужен для имени в DTO */
  async listForMovie(movieId: string): Promise<ReviewDto[]> {
    await this.movies.findOneByOrFail({ id: movieId });
    const rows = await this.reviews.find({
      where: { movieId },
      order: { createdAt: 'DESC' },
      relations: { user: true },
    });
    return rows.map((row) => toReviewDto(row));
  }

  /**
   * Новый отзыв. Право на него даёт подтверждённая бронь на фильм —
   * проверяем до записи (двух передумавших успокоит uq-констрейнт:
   * гонку дубля решает БД, проигравший получает 409 reviewExists).
   * Отзыв и пересчёт агрегатов фильма пишутся одной транзакцией;
   * после коммита каталог покидает кэш (рейтинг на карточках).
   */
  async create(
    movieId: string,
    dto: CreateReviewDto,
    user: AuthUser,
  ): Promise<ReviewDto> {
    await this.movies.findOneByOrFail({ id: movieId });
    const confirmed = await this.bookings.findOneBy({
      userId: user.id,
      movieId,
      status: 'CONFIRMED',
    });
    if (!confirmed) {
      throw new ForbiddenException(
        'Отзыв можно оставить только о фильме, на который была подтверждённая бронь',
      );
    }

    const review = await this.dataSource.transaction(async (em) => {
      let saved: Review;
      try {
        saved = await em.save(
          em.create(Review, {
            movieId,
            userId: user.id,
            rating: dto.rating,
            text: dto.text.trim(),
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message: 'Вы уже оставили отзыв на этот фильм',
            code: 'reviewExists',
          });
        }
        throw err;
      }
      await this.recomputeRating(em, movieId);
      return saved;
    });

    await this.invalidate(movieId);
    this.logger.log(
      `Отзыв ${review.id} на фильм ${movieId} от ${user.email}: ${dto.rating}/5`,
    );
    return toReviewDto(review, user.name);
  }

  /**
   * Удаление отзыва: автор или админ. Поиск скоуплен по фильму —
   * id чужого фильма не даёт добраться до отзыва другого фильма.
   * Агрегаты пересчитываются той же транзакцией, кэш сбрасывается.
   */
  async remove(movieId: string, id: string, user: AuthUser): Promise<void> {
    const review = await this.reviews.findOneByOrFail({ id, movieId });
    if (review.userId !== user.id && user.role !== 'admin') {
      throw new ForbiddenException('Это не ваш отзыв');
    }

    await this.dataSource.transaction(async (em) => {
      await em.delete(Review, { id });
      await this.recomputeRating(em, movieId);
    });

    await this.invalidate(movieId);
    this.logger.log(
      `Удалён отзыв ${id} (фильм ${movieId}, ${user.email}${user.role === 'admin' ? ', админ' : ''})`,
    );
  }

  /**
   * Денормализованный рейтинг фильма: средняя оценка и число отзывов.
   * Пересчитывается от источника (reviews), а не инкрементом —
   * ударам и дублям нечего накапливать ошибку. AVG из pg приходит
   * строкой, поэтому Number().
   */
  private async recomputeRating(
    em: EntityManager,
    movieId: string,
  ): Promise<void> {
    const raw = await em
      .createQueryBuilder(Review, 'r')
      .select('AVG(r.rating)', 'avg')
      .addSelect('COUNT(*)', 'count')
      .where('r.movieId = :movieId', { movieId })
      .getRawOne<{ avg: string | null; count: string }>();
    await em.update(Movie, { id: movieId }, {
      ratingAvg: Number(raw?.avg ?? 0),
      ratingCount: Number(raw?.count ?? 0),
    });
  }

  /** рейтинг на карточках — каталог и карточка фильма покидают кэш */
  private async invalidate(movieId: string): Promise<void> {
    await this.redis.del(MOVIES_KEY, movieKey(movieId));
  }
}

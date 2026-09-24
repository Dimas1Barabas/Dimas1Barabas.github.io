import { Injectable, Logger } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { MoviesService } from '../movies/movies.service';
import { RedisService } from '../redis/redis.service';
import {
  RecommendationCandidate,
  RecommendationItem,
  RecommendationsBasis,
  RecommendationsClient,
} from './recommendations.client';

/** TTL кэша рекомендаций: новый сигнал зрителя гасит ключ раньше (консьюмер) */
const RECS_TTL_SEC = 60;

/** размер топа «Вам понравится» */
export const RECS_LIMIT = 4;

/** ключ кэша персонального топа (v1 — форма ответа) */
export const recsKey = (userId: string): string => `recs:${userId}:v1`;

/** Позиция топа «Вам понравится» — со скором и человеческой причиной */
export class RecommendationItemDto implements RecommendationItem {
  @ApiProperty({ example: '0c9f6f2e-…', description: 'uuid фильма' })
  movieId!: string;

  @ApiProperty({ example: 'Марсианин' })
  title!: string;

  @ApiProperty({ example: 'фантастика' })
  genre!: string;

  @ApiProperty({ example: 0.82, description: 'нормализованный скор 0..1' })
  score!: number;

  @ApiProperty({
    example: 'вы часто смотрите «фантастика»',
    description: 'почему фильм в топе — витрина показывает под карточкой',
  })
  reason!: string;
}

/** Ответ «Вам понравится» */
export class RecommendationsDto {
  @ApiProperty({ type: [RecommendationItemDto] })
  items!: RecommendationItemDto[];

  @ApiProperty({
    enum: ['profile', 'popular', 'empty', 'unavailable'],
    description:
      'profile — по жанровым весам зрителя; popular — холодный старт ' +
      '(по рейтингу афиши); empty — рекомендовать нечего; unavailable — ' +
      'КиноСоветник не ответил, блок на витрине скрывается',
  })
  basis!: RecommendationsBasis;
}

/**
 * Фасад рекомендаций: собирает кандидатов из каталога, спрашивает
 * КиноСоветник по gRPC и кэширует топ в Redis. Недоступность сервиса —
 * НЕ ошибка запроса: витрина просто живёт без блока «Вам понравится».
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly recos: RecommendationsClient,
    private readonly movies: MoviesService,
    private readonly redis: RedisService,
  ) {}

  /** персональный топ афиши; кэш — как у каталога (60 c от источника) */
  async my(userId: string): Promise<RecommendationsDto> {
    const { value } = await this.redis.withCache<RecommendationsDto>(
      recsKey(userId),
      RECS_TTL_SEC,
      async () => this.load(userId),
    );
    return value;
  }

  /** Новый сигнал зрителя (бронь/отзыв) — топ перестаёт быть актуальным */
  async invalidateFor(userId: string): Promise<void> {
    await this.redis.del(recsKey(userId));
  }

  private async load(userId: string): Promise<RecommendationsDto> {
    const catalog = await this.movies.findAll();
    const candidates: RecommendationCandidate[] = catalog.data.map((m) => ({
      movieId: m.id,
      title: m.title,
      genre: m.genre,
      ratingAvg: m.ratingAvg ?? 0,
      ratingCount: m.ratingCount ?? 0,
    }));
    try {
      const resp = await this.recos.forUser(userId, candidates, RECS_LIMIT);
      const basis = basisOf(resp.basis);
      return { items: resp.items ?? [], basis };
    } catch (err) {
      // сервис недоступен/отвалился по дедлайну — витрина без блока
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`КиноСоветник недоступен (${message}) — топ пропущен`);
      return { items: [], basis: 'unavailable' };
    }
  }
}

/** неизвестный basis сервиса не должен ломать тип ответа */
function basisOf(raw: string | undefined): RecommendationsBasis {
  return raw === 'profile' || raw === 'popular' || raw === 'empty'
    ? raw
    : 'unavailable';
}

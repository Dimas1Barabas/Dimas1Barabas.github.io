import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Movie } from '../movies/movie.entity';
import { User } from '../users/user.entity';

/**
 * Отзыв на фильм: один на пользователя. Составной уникальный констрейнт
 * (user_id, movie_id) — арбитр дубля: второй отзыв того же автора
 * получает 23505 и откатывается → 409 reviewExists.
 * Право на отзыв (подтверждённая бронь) проверяет сервис — в схеме его нет.
 */
@Entity('reviews')
@Unique('uq_reviews_user_movie', ['userId', 'movieId'])
export class Review {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'movie_id' })
  movieId: string;

  @ManyToOne(() => Movie, { nullable: false })
  @JoinColumn({ name: 'movie_id' })
  movie: Movie;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** оценка 1–5 */
  @Column({ type: 'smallint' })
  rating: number;

  @Column({ length: 1000 })
  text: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

export interface ReviewDto {
  id: string;
  movieId: string;
  userId: string;
  authorName: string;
  rating: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** authorName — имя из профиля автора; при создании берём его из JWT */
export function toReviewDto(review: Review, authorName?: string): ReviewDto {
  return {
    id: review.id,
    movieId: review.movieId,
    userId: review.userId,
    authorName: authorName ?? review.user?.name ?? '—',
    rating: review.rating,
    text: review.text,
    createdAt: review.createdAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

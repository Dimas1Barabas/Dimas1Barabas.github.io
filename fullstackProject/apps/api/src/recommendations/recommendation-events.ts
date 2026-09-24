/** Контракты сигналов рекомендаций (обмен «cinema», topic) */

/**
 * API → КиноСоветник (recommendation-service, Go): routing key
 * «recommendation.booking.confirmed». Публикуется, когда вердикт воркера
 * применён и бронь стала CONFIRMED: «зритель сходил на фильм» — базовый
 * сигнал профиля. bookingId — dedup-ключ: редоставления гасятся
 * uq-констрейнтом на стороне сервиса.
 */
export interface RecommendationBookingEvent {
  userId: string;
  movieId: string;
  movieTitle: string;
  genre: string;
  bookingId: string;
  occurredAt: string;
}

/**
 * API → КиноСоветник: routing key «recommendation.review.created».
 * Публикуется после коммита отзыва и пересчёта агрегатов: отзыв — сигнал
 * сильнее брони, рейтинг взвешивает вклад жанра (5/5 → максимум веса).
 */
export interface RecommendationReviewEvent {
  userId: string;
  movieId: string;
  movieTitle: string;
  genre: string;
  rating: number;
  reviewId: string;
  occurredAt: string;
}

// Зеркало чистой логики скоринга КиноСоветника
// (services/recommendation-service/internal/domain/scoring.go).
// Обе реализации обязаны сходиться: спек ниже сверяет ключевые векторы
// с готестами (веса сигналов, косинус, порядок, причины, холодный старт).

/** подтверждённая бронь добавляет жанру 1.0 */
export const BOOKING_WEIGHT = 1.0;
/** отзыв весомее брони: рейтинг 5 даёт 1.2 */
export const REVIEW_FACTOR = 1.2;
/** доля косинусной близости жанров в скоре */
export const GENRE_SHARE = 0.7;
/** доля рейтинга фильма в скоре */
export const RATING_SHARE = 0.3;
/** размер топа, когда limit <= 0 */
export const DEFAULT_LIMIT = 4;

/** тип взаимодействия зрителя с фильмом */
export type SignalKind = 'booking' | 'review';

/** сигнал профиля: бронь CONFIRMED («смотрел») или отзыв («оценил») */
export interface RecSignal {
  movieId: string;
  genre: string;
  kind: SignalKind;
  /** 1..5, только для отзыва */
  rating: number;
  /** kind + ':' + bookingId/reviewId — дубль редоставления не проходит */
  dedupKey: string;
}

/** кандидат афиши — фильм, который вообще можно забронировать */
export interface RecoCandidate {
  movieId: string;
  title: string;
  genre: string;
  ratingAvg: number;
  ratingCount: number;
}

/** профиль зрителя: жанровые веса и множество «уже видел» */
export interface RecoProfile {
  genreWeights: Record<string, number>;
  seen: Set<string>;
}

/** позиция топа со скором и причиной */
export interface RecoItem extends RecoCandidate {
  score: number;
  reason: string;
}

/** на чём построен топ */
export type RecoBasis = 'profile' | 'popular' | 'empty';

/** вклад одного сигнала в жанровый вес профиля */
export function signalWeight(kind: SignalKind, rating: number): number {
  return kind === 'review' ? (REVIEW_FACTOR * rating) / 5 : BOOKING_WEIGHT;
}

/** сборка профиля из истории сигналов; порядок не важен */
export function buildProfile(signals: RecSignal[]): RecoProfile {
  const genreWeights: Record<string, number> = {};
  const seen = new Set<string>();
  for (const s of signals) {
    genreWeights[s.genre] =
      (genreWeights[s.genre] ?? 0) + signalWeight(s.kind, s.rating);
    seen.add(s.movieId);
  }
  return { genreWeights, seen };
}

/**
 * Косинус между one-hot вектором жанра фильма и профилем:
 * модуль фильма = 1, поэтому это вес жанра / модуль профиля.
 */
export function genreCosine(
  genre: string,
  weights: Record<string, number>,
): number {
  const w = weights[genre] ?? 0;
  if (w === 0) return 0;
  let norm = 0;
  for (const v of Object.values(weights)) norm += v * v;
  return w / Math.sqrt(norm);
}

/** 0..1: смесь косинуса жанра с профилем и рейтинга фильма */
function scoreOf(m: RecoCandidate, p: RecoProfile, cold: boolean): number {
  if (cold) return m.ratingAvg / 5;
  return (
    GENRE_SHARE * genreCosine(m.genre, p.genreWeights) +
    RATING_SHARE * (m.ratingAvg / 5)
  );
}

/** человеческая причина рекомендации для витрины */
function reasonOf(m: RecoCandidate, p: RecoProfile, cold: boolean): string {
  if (!cold && (p.genreWeights[m.genre] ?? 0) > 0) {
    return `вы часто смотрите «${m.genre}»`;
  }
  if (m.ratingCount > 0) return 'высокий рейтинг зрителей';
  return 'новинка афиши';
}

/**
 * Топ-limit фильмов среди кандидатов: просмотренное исключается,
 * пустой профиль — холодный старт по рейтингу; ничья решается названием.
 */
export function rankRecommendations(
  candidates: RecoCandidate[],
  signals: RecSignal[],
  limit = 0,
): { items: RecoItem[]; basis: RecoBasis } {
  const n = limit > 0 ? limit : DEFAULT_LIMIT;
  const profile = buildProfile(signals);
  const fresh = candidates.filter((m) => !profile.seen.has(m.movieId));
  if (!fresh.length) return { items: [], basis: 'empty' };

  const cold = Object.keys(profile.genreWeights).length === 0;
  const items: RecoItem[] = fresh.map((m) => ({
    ...m,
    score: scoreOf(m, profile, cold),
    reason: reasonOf(m, profile, cold),
  }));
  items.sort((a, b) =>
    a.score !== b.score ? b.score - a.score : a.title < b.title ? -1 : 1,
  );
  return { items: items.slice(0, n), basis: cold ? 'popular' : 'profile' };
}

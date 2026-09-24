import { describe, expect, it } from 'vitest';
import {
  BOOKING_WEIGHT,
  DEFAULT_LIMIT,
  GENRE_SHARE,
  REVIEW_FACTOR,
  RATING_SHARE,
  buildProfile,
  genreCosine,
  rankRecommendations,
  signalWeight,
} from '@/shared/lib/recommendation';

/**
 * Зеркало логики КиноСоветника: векторы сверены с готестами
 * services/recommendation-service/internal/domain/scoring_test.go —
 * числа и порядок обязаны совпадать, иначе демо разойдётся с живым сервисом.
 */

const afisha = [
  { movieId: 'm1', title: 'Дюна', genre: 'фантастика', ratingAvg: 3.0, ratingCount: 3 },
  { movieId: 'm2', title: 'Осенний вальс', genre: 'драма', ratingAvg: 4.9, ratingCount: 40 },
  { movieId: 'm3', title: 'Скрик', genre: 'хоррор', ratingAvg: 0, ratingCount: 0 },
  { movieId: 'm4', title: 'Марсианин', genre: 'фантастика', ratingAvg: 4.0, ratingCount: 9 },
];

const profileSignals = [
  { movieId: 'mX', genre: 'фантастика', kind: 'booking' as const, rating: 0, dedupKey: 'booking:b1' },
  { movieId: 'mY', genre: 'фантастика', kind: 'review' as const, rating: 5, dedupKey: 'review:r1' },
];

describe('lib/recommendation: веса и профиль', () => {
  it('бронь даёт 1.0, отзыв — rating/5 × 1.2', () => {
    expect(signalWeight('booking', 0)).toBe(BOOKING_WEIGHT); // 1.0
    expect(signalWeight('review', 5)).toBe(REVIEW_FACTOR); // 1.2
    expect(signalWeight('review', 3)).toBeCloseTo(0.72, 10);
    expect(signalWeight('review', 1)).toBeCloseTo(0.24, 10);
  });

  it('профиль суммирует веса жанров и помнит просмотренное', () => {
    const p = buildProfile(profileSignals);
    expect(p.genreWeights['фантастика']).toBeCloseTo(2.2, 10);
    expect(p.seen.has('mX')).toBe(true);
    expect(p.seen.has('mY')).toBe(true);
    expect(p.seen.has('m1')).toBe(false);
  });

  it('косинус: вес жанра / модуль профиля; чужой жанр — 0', () => {
    const weights = { фантастика: 2, драма: 1 };
    expect(genreCosine('фантастика', weights)).toBeCloseTo(2 / Math.sqrt(5), 10);
    expect(genreCosine('хоррор', weights)).toBe(0);
  });
});

describe('lib/recommendation: ранжирование', () => {
  it('жанр профиля обгоняет чужой жанр с высоким рейтингом', () => {
    const top = rankRecommendations(afisha, profileSignals);
    expect(top.basis).toBe('profile');
    expect(top.items[0].movieId).toBe('m4'); // 0.7×1 + 0.3×0.8 = 0.94
    expect(top.items[0].reason).toBe('вы часто смотрите «фантастика»');
    expect(top.items[0].score).toBeCloseTo(GENRE_SHARE * 1 + RATING_SHARE * 0.8, 10);
  });

  it('холодный старт — по рейтингу, причины честные', () => {
    const top = rankRecommendations(afisha, []);
    expect(top.basis).toBe('popular');
    expect(top.items[0].movieId).toBe('m2'); // 4.9 из 5
    expect(top.items[0].reason).toBe('высокий рейтинг зрителей');
    expect(top.items[3].reason).toBe('новинка афиши'); // без отзывов
  });

  it('просмотренное исключается; всё просмотрено — empty', () => {
    const seenAll = afisha.map((m) => ({
      movieId: m.movieId,
      genre: m.genre,
      kind: 'booking' as const,
      rating: 0,
      dedupKey: `b:${m.movieId}`,
    }));
    const top = rankRecommendations(afisha, seenAll);
    expect(top.basis).toBe('empty');
    expect(top.items).toEqual([]);
  });

  it('лимит срезает; дефолт 4; ничья решается названием', () => {
    const twins = [
      { movieId: 'x2', title: 'Ясный день', genre: 'g', ratingAvg: 4, ratingCount: 1 },
      { movieId: 'x1', title: 'Антрацит', genre: 'g', ratingAvg: 4, ratingCount: 1 },
    ];
    const tie = rankRecommendations(twins, []);
    expect(tie.items[0].title).toBe('Антрацит');

    expect(rankRecommendations(afisha, []).items).toHaveLength(DEFAULT_LIMIT);
    expect(rankRecommendations(afisha, [], 2).items).toHaveLength(2);
  });
});

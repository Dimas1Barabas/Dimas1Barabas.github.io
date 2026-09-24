package domain

import (
	"fmt"
	"math"
	"sort"
)

// Веса логики — один источник правды для Go-сервиса и веб-зеркала
// (apps/web/src/shared/lib/recommendation.ts повторяет константы и формулы).
const (
	bookingWeight = 1.0 // подтверждённая бронь добавляет жанру 1.0
	reviewFactor  = 1.2 // отзыв весомее брони: рейтинг 5 даёт 1.2
	genreShare    = 0.7 // доля косинусной близости жанров в скоре
	ratingShare   = 0.3 // доля рейтинга фильма в скоре

	// DefaultLimit — размер топа, когда limit в запросе <= 0.
	DefaultLimit = 4
)

// SignalWeight — вклад одного сигнала в жанровый вес профиля.
func SignalWeight(kind SignalKind, rating int) float64 {
	if kind == KindReview {
		return reviewFactor * float64(rating) / 5
	}
	return bookingWeight
}

// BuildProfile — чистая сборка профиля из истории сигналов.
// Порядок сигналов не важен: веса суммируются, Seen — множество.
func BuildProfile(userID string, signals []Signal) Profile {
	p := Profile{UserID: userID, GenreWeights: map[string]float64{}, Seen: map[string]bool{}}
	for _, s := range signals {
		p.GenreWeights[s.Genre] += SignalWeight(s.Kind, s.Rating)
		p.Seen[s.MovieID] = true
	}
	return p
}

// Rank — топ-limit фильмов среди кандидатов для профиля.
// Просмотренное исключается; пустой профиль — холодный старт по рейтингу.
func Rank(candidates []Movie, p Profile, limit int) Recommendation {
	if limit <= 0 {
		limit = DefaultLimit
	}
	fresh := make([]Movie, 0, len(candidates))
	for _, m := range candidates {
		if !p.Seen[m.MovieID] {
			fresh = append(fresh, m)
		}
	}
	if len(fresh) == 0 {
		return Recommendation{Items: []Scored{}, Basis: BasisEmpty}
	}
	cold := len(p.GenreWeights) == 0
	scored := make([]Scored, 0, len(fresh))
	for _, m := range fresh {
		scored = append(scored, Scored{
			Movie:  m,
			Score:  score(m, p, cold),
			Reason: reason(m, p, cold),
		})
	}
	// Детерминизм при равном скоре — по названию.
	sort.Slice(scored, func(i, j int) bool {
		if scored[i].Score != scored[j].Score {
			return scored[i].Score > scored[j].Score
		}
		return scored[i].Title < scored[j].Title
	})
	if len(scored) > limit {
		scored = scored[:limit]
	}
	basis := BasisProfile
	if cold {
		basis = BasisPopular
	}
	return Recommendation{Items: scored, Basis: basis}
}

// score — 0..1: смесь косинуса жанра с профилем и рейтинга фильма.
func score(m Movie, p Profile, cold bool) float64 {
	if cold {
		return m.RatingAvg / 5
	}
	return genreShare*genreCosine(m.Genre, p.GenreWeights) + ratingShare*(m.RatingAvg/5)
}

// genreCosine — косинус между one-hot вектором жанра фильма и профилем
// (модуль фильма = 1, поэтому это просто вес жанра / модуль профиля).
func genreCosine(genre string, weights map[string]float64) float64 {
	w := weights[genre]
	if w == 0 {
		return 0
	}
	var norm float64
	for _, v := range weights {
		norm += v * v
	}
	return w / math.Sqrt(norm)
}

// reason — человеческая причина рекомендации для витрины.
func reason(m Movie, p Profile, cold bool) string {
	if !cold && p.GenreWeights[m.Genre] > 0 {
		return fmt.Sprintf("вы часто смотрите «%s»", m.Genre)
	}
	if m.RatingCount > 0 {
		return "высокий рейтинг зрителей"
	}
	return "новинка афиши"
}

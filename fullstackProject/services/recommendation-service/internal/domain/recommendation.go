package domain

import (
	"errors"
	"time"
)

// SignalKind — тип взаимодействия зрителя с фильмом.
type SignalKind string

const (
	// KindBooking — подтверждённая бронь (сигнал «сходил на фильм»).
	KindBooking SignalKind = "booking"
	// KindReview — оставленный отзыв (сигнал «оценил фильм»).
	KindReview SignalKind = "review"
)

// Signal — событие взаимодействия зрителя с фильмом (из RabbitMQ).
// Редоставления гасятся по DedupKey (kind + bookingId/reviewId).
type Signal struct {
	UserID     string
	MovieID    string
	MovieTitle string
	Genre      string
	Kind       SignalKind
	Rating     int // 1..5, только для отзыва
	DedupKey   string
	OccurredAt time.Time
}

var (
	// ErrInvalidSignal — сигнал не проходит валидацию: это poison,
	// ретраить его бессмысленно.
	ErrInvalidSignal = errors.New("некорректный сигнал рекомендаций")
	// ErrEmptyUserID — запрос рекомендаций без зрителя.
	ErrEmptyUserID = errors.New("пустой идентификатор зрителя")
)

// Validate — бизнес-проверка сигнала перед записью в хранилище.
func (s Signal) Validate() error {
	if s.UserID == "" || s.MovieID == "" || s.Genre == "" || s.DedupKey == "" {
		return ErrInvalidSignal
	}
	switch s.Kind {
	case KindBooking:
		return nil
	case KindReview:
		if s.Rating < 1 || s.Rating > 5 {
			return ErrInvalidSignal
		}
		return nil
	default:
		return ErrInvalidSignal
	}
}

// Movie — кандидат афиши, пришедший в запросе рекомендаций.
type Movie struct {
	MovieID     string
	Title       string
	Genre       string
	RatingAvg   float64 // 0..5, 0 = отзывов нет
	RatingCount int
}

// Profile — профиль зрителя: жанровые веса и множество «уже видел».
type Profile struct {
	UserID       string
	GenreWeights map[string]float64
	Seen         map[string]bool
}

// Scored — фильм со скором и человеческой причиной попадания в топ.
type Scored struct {
	Movie
	Score  float64 // 0..1
	Reason string
}

// Basis — на чём построен топ ответа.
const (
	BasisProfile = "profile" // по жанровым весам зрителя
	BasisPopular = "popular" // холодный старт: по рейтингу афиши
	BasisEmpty   = "empty"   // рекомендовать нечего
)

// Recommendation — ответ КиноСоветника.
type Recommendation struct {
	Items []Scored
	Basis string
}

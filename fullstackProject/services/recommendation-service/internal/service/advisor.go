package service

import (
	"context"
	"time"

	"recommendation-service/internal/domain"
)

// Advisor — use-case КиноСоветника: копит сигналы зрителей
// и ранжирует афишу по профилю.
type Advisor struct {
	store domain.SignalStore
	now   func() time.Time
}

func NewAdvisor(store domain.SignalStore) *Advisor {
	return &Advisor{store: store, now: time.Now}
}

// HandleSignal — валидирует и сохраняет сигнал.
// ErrInvalidSignal трактуется консьюмером как poison, прочее — как retry.
func (a *Advisor) HandleSignal(ctx context.Context, s domain.Signal) error {
	if err := s.Validate(); err != nil {
		return err
	}
	if s.OccurredAt.IsZero() {
		s.OccurredAt = a.now()
	}
	return a.store.Append(ctx, s)
}

// Recommend — топ фильмов зрителя среди кандидатов афиши.
func (a *Advisor) Recommend(ctx context.Context, userID string, candidates []domain.Movie, limit int) (domain.Recommendation, error) {
	if userID == "" {
		return domain.Recommendation{}, domain.ErrEmptyUserID
	}
	signals, err := a.store.List(ctx, userID)
	if err != nil {
		return domain.Recommendation{}, err
	}
	profile := domain.BuildProfile(userID, signals)
	return domain.Rank(candidates, profile, limit), nil
}

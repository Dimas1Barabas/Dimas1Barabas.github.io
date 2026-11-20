package domain

import (
	"context"
	"time"
)

// DecisionStore — порт хранилища решений (память или Postgres).
//
// Save идемпотентен по BookingID: повторный Score той же брони
// возвращает уже записанное решение — вердикт не пересматривается
// задним числом (решение могло уйти человеку, а факты — измениться).
// Resolve — условный переход из pending_review: гонку двух админов
// решает хранилище, проигравший получает ErrAlreadyResolved.
type DecisionStore interface {
	Save(ctx context.Context, d Decision) (DecisionRecord, error)
	Resolve(ctx context.Context, bookingID string, action ResolveAction, by string) (DecisionRecord, error)
	Get(ctx context.Context, bookingID string) (DecisionRecord, error)
	List(ctx context.Context, status Status, limit int) ([]DecisionRecord, error)
}

// FixedClock — источник времени для витрины памяти: тесты подставляют
// свой, боевой код использует time.Now.
type FixedClock interface {
	Now() time.Time
}

package domain

import "context"

// SignalStore — порт хранилища сигналов (память или Postgres).
type SignalStore interface {
	// Append добавляет сигнал; редоставление с тем же DedupKey — no-op.
	Append(ctx context.Context, s Signal) error
	// List возвращает историю сигналов зрителя.
	List(ctx context.Context, userID string) ([]Signal, error)
}

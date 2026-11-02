package domain

import (
	"context"
	"time"
)

// FlagStore — порт хранилища «Суфлёра» (память или Postgres).
// Save — upsert: правка состояния флага и строка аудита одним шагом.
type FlagStore interface {
	Get(ctx context.Context, key string) (Flag, bool, error)
	List(ctx context.Context) ([]Flag, error)
	Save(ctx context.Context, f Flag) error
	Delete(ctx context.Context, key string) (bool, error)
	Revisions(ctx context.Context, key string, limit int) ([]Revision, error)
}

// Revision — строка аудита: кто, когда и каким снимком менял флаг.
// Хранится ПОСЛЕ удаления флага (без FK): история переживает флаг —
// «кто выключал» не должен пропадать вместе с тумблером.
type Revision struct {
	Key       string
	ChangedBy string
	ChangedAt time.Time
	Snapshot  Flag // состояние флага ПОСЛЕ правки
}

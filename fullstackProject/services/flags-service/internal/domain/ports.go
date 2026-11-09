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

// ExperimentStore — счётчики A/B-метрик: экспозиции и конверсии по
// (флаг, вариант). Отдельный порт: правки флагов и метрики —
// независимые ответственности; назначение варианта НЕ хранится —
// оно детерминировано бакетингом и пересчитывается на каждом отчёте.
type ExperimentStore interface {
	// Add — +1 к экспозиции (conversion=false) или конверсии (true).
	Add(ctx context.Context, key, variant string, conversion bool) error
	// Stats — все строки метрик; variant="" — база эксперимента,
	// у обычных флагов метрики считают implicit-варианты on/off.
	Stats(ctx context.Context) ([]VariantStat, error)
}

// VariantStat — строка метрик эксперимента для витрины.
type VariantStat struct {
	Key         string
	Variant     string
	Exposures   int64
	Conversions int64
}

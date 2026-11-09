// Package memory — FlagStore в памяти процесса: дефолт, стенд без
// Postgres не падает. Рестарт обнуляет флаги — для локальной работы
// осознанно; прод-стенд compose ходит в Postgres.
package memory

import (
	"context"
	"sort"
	"sync"

	"flags-service/internal/domain"
)

var (
	_ domain.FlagStore       = (*Store)(nil)
	_ domain.ExperimentStore = (*Store)(nil)
)

// Store — карта флагов, журнал правок и счётчики экспериментов под
// одним мьютексом.
type Store struct {
	mu        sync.Mutex
	flags     map[string]domain.Flag
	revisions []domain.Revision
	stats     map[string]*domain.VariantStat // ключ "key\x00variant"
}

// NewStore — пустое хранилище.
func NewStore() *Store {
	return &Store{flags: make(map[string]domain.Flag), stats: make(map[string]*domain.VariantStat)}
}

// Get — снимок флага по ключу.
func (s *Store) Get(_ context.Context, key string) (domain.Flag, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, ok := s.flags[key]
	return f, ok, nil
}

// List — все флаги, отсортированы по ключу: снимок детерминирован.
func (s *Store) List(_ context.Context) ([]domain.Flag, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.Flag, 0, len(s.flags))
	for _, f := range s.flags {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// Save — upsert флага + строка аудита.
func (s *Store) Save(_ context.Context, f domain.Flag) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flags[f.Key] = f
	s.revisions = append(s.revisions, domain.Revision{
		Key:       f.Key,
		ChangedBy: f.UpdatedBy,
		ChangedAt: f.UpdatedAt,
		Snapshot:  f,
	})
	return nil
}

// Delete — убрать флаг; аудит остаётся.
func (s *Store) Delete(_ context.Context, key string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.flags[key]; !ok {
		return false, nil
	}
	delete(s.flags, key)
	return true, nil
}

// Revisions — журнал правок флага, свежими сверху.
func (s *Store) Revisions(_ context.Context, key string, limit int) ([]domain.Revision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.Revision, 0)
	for i := len(s.revisions) - 1; i >= 0 && len(out) < limit; i-- {
		if s.revisions[i].Key == key {
			out = append(out, s.revisions[i])
		}
	}
	return out, nil
}

// Add — +1 к экспозиции/конверсии варианта: строка метрик заводится
// по первому отчёту (как NULL-строка в SQL: нули не храним).
func (s *Store) Add(_ context.Context, key, variant string, conversion bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := key + "\x00" + variant
	row, ok := s.stats[id]
	if !ok {
		row = &domain.VariantStat{Key: key, Variant: variant}
		s.stats[id] = row
	}
	if conversion {
		row.Conversions++
	} else {
		row.Exposures++
	}
	return nil
}

// Stats — все строки метрик, отсортированы (флаг, вариант): витрина
// детерминирована между вызовами.
func (s *Store) Stats(_ context.Context) ([]domain.VariantStat, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.VariantStat, 0, len(s.stats))
	for _, row := range s.stats {
		out = append(out, *row)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Key != out[j].Key {
			return out[i].Key < out[j].Key
		}
		return out[i].Variant < out[j].Variant
	})
	return out, nil
}

package memory

import (
	"context"
	"sync"

	"recommendation-service/internal/domain"
)

// Store — in-memory хранилище сигналов (STORAGE=memory, тесты).
type Store struct {
	mu      sync.Mutex
	signals []domain.Signal
	seen    map[string]bool // дедупликация редоставлений
}

func NewStore() *Store {
	return &Store{seen: map[string]bool{}}
}

func (s *Store) Append(_ context.Context, sig domain.Signal) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen[sig.DedupKey] {
		return nil
	}
	s.seen[sig.DedupKey] = true
	s.signals = append(s.signals, sig)
	return nil
}

func (s *Store) List(_ context.Context, userID string) ([]domain.Signal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.Signal, 0)
	for _, sig := range s.signals {
		if sig.UserID == userID {
			out = append(out, sig)
		}
	}
	return out, nil
}

var _ domain.SignalStore = (*Store)(nil)

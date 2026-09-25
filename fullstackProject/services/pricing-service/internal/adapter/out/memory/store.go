package memory

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"pricing-service/internal/domain"
)

// Store — in-memory хранилище Тарификатора (STORAGE=memory, тесты).
type Store struct {
	mu      sync.Mutex
	demand  map[string]int       // sessionID → занятые места
	updated map[string]time.Time // sessionID → момент последнего события
	applied map[string]bool      // «bookingID:kind» → событие проведено
	quotes  []domain.QuoteRecord // история квотов, старые внизу
}

func NewStore() *Store {
	return &Store{
		demand:  map[string]int{},
		updated: map[string]time.Time{},
		applied: map[string]bool{},
	}
}

// ApplyHeld: +seats; дубль по (bookingID, held) — no-op, зеркалит
// ON CONFLICT DO NOTHING Postgres.
func (s *Store) ApplyHeld(_ context.Context, sessionID, bookingID string, seats int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := bookingID + ":held"
	if s.applied[key] {
		return false, nil
	}
	s.applied[key] = true
	s.demand[sessionID] += seats
	s.updated[sessionID] = time.Now()
	return true, nil
}

// ApplyReleased: −seats, но не ниже нуля (двойное освобождение
// не должно уводить спрос в минус).
func (s *Store) ApplyReleased(_ context.Context, sessionID, bookingID string, seats int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := bookingID + ":released"
	if s.applied[key] {
		return false, nil
	}
	s.applied[key] = true
	if v := s.demand[sessionID] - seats; v > 0 {
		s.demand[sessionID] = v
	} else {
		s.demand[sessionID] = 0
	}
	s.updated[sessionID] = time.Now()
	return true, nil
}

// Demand — занятые места сеанса (0 — событий не было).
func (s *Store) Demand(_ context.Context, sessionID string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.demand[sessionID], nil
}

// LogQuote дописывает расчёт в историю.
func (s *Store) LogQuote(_ context.Context, sessionID string, q domain.Quote) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.quotes = append(s.quotes, domain.QuoteRecord{
		SessionID:    sessionID,
		BasePriceRub: q.BasePriceRub,
		PriceRub:     q.PriceRub,
		Factors:      factorSummary(q.Factors),
		CreatedAt:    time.Now(),
	})
	return nil
}

// ListQuotes — свежими сверху (зеркалит ORDER BY id DESC витрины Postgres).
func (s *Store) ListQuotes(_ context.Context) ([]domain.QuoteRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.QuoteRecord, 0, len(s.quotes))
	for i := len(s.quotes) - 1; i >= 0; i-- {
		out = append(out, s.quotes[i])
	}
	return out, nil
}

// ListDemand — проекция по сеансам, свежими сверху.
func (s *Store) ListDemand(_ context.Context) ([]domain.DemandRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.DemandRecord, 0, len(s.demand))
	for sessionID, occupied := range s.demand {
		out = append(out, domain.DemandRecord{
			SessionID: sessionID,
			Occupied:  occupied,
			UpdatedAt: s.updated[sessionID],
		})
	}
	// детерминизм витрины: по сеансу — map гоняет порядок
	sortBySession(out)
	return out, nil
}

// factorSummary — компактная раскладка «evening+20%; weekend+10%».
func factorSummary(factors []domain.Factor) string {
	parts := make([]string, 0, len(factors))
	for _, f := range factors {
		parts = append(parts, fmt.Sprintf("%s%+d%%", f.Code, f.Percent))
	}
	return strings.Join(parts, "; ")
}

// sortBySession — детерминированный порядок витрины спроса.
func sortBySession(rows []domain.DemandRecord) {
	sort.Slice(rows, func(i, j int) bool { return rows[i].SessionID < rows[j].SessionID })
}

var _ domain.DemandStore = (*Store)(nil)

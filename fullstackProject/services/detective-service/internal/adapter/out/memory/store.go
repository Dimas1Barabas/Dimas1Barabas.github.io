// Package memory — DecisionStore в памяти процесса: дефолт, стенд без
// Postgres не падает. Рестарт обнуляет витрину — осознанно: решения
// «на подумать» живут в очереди ревью недолго, потеря истории на
// рестарте стенда дешевле обязательной БД.
package memory

import (
	"context"
	"sort"
	"sync"
	"time"

	"detective-service/internal/domain"
)

var _ domain.DecisionStore = (*Store)(nil)

// Store — решения под мьютексом: карта для точечного доступа и срез
// для честного порядка витрины.
type Store struct {
	mu        sync.Mutex
	byBooking map[string]domain.DecisionRecord
	order     []string // booking_id в порядке поступления
	now       func() time.Time
}

// NewStore — пустое хранилище с боевыми часами; тесты подменяют now.
func NewStore() *Store {
	return &Store{byBooking: make(map[string]domain.DecisionRecord), now: time.Now}
}

// Save — записать решение; идемпотентен по booking_id: существующее
// возвращается как есть, вердикт не пересматривается задним числом.
func (s *Store) Save(_ context.Context, d domain.Decision) (domain.DecisionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.byBooking[d.Facts.BookingID]; ok {
		return existing, nil
	}
	rec := domain.DecisionRecord{
		Decision:  d,
		Status:    domain.StatusOf(d.Verdict),
		CreatedAt: s.now(),
	}
	s.byBooking[d.Facts.BookingID] = rec
	s.order = append(s.order, d.Facts.BookingID)
	return rec, nil
}

// Resolve — условный переход из pending_review: проигравший гонку
// двух админов получает ErrAlreadyResolved, отсутствующая бронь — NotFound.
func (s *Store) Resolve(_ context.Context, bookingID string, action domain.ResolveAction, by string) (domain.DecisionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec, ok := s.byBooking[bookingID]
	if !ok {
		return domain.DecisionRecord{}, domain.ErrDecisionNotFound
	}
	if rec.Status != domain.StatusPendingReview {
		return domain.DecisionRecord{}, domain.ErrAlreadyResolved
	}
	status, err := domain.ResolveStatus(action)
	if err != nil {
		return domain.DecisionRecord{}, err
	}
	rec.Status = status
	rec.ResolvedBy = by
	rec.ResolvedAt = s.now()
	s.byBooking[bookingID] = rec
	return rec, nil
}

// Get — одно решение по идемпотентному ключу.
func (s *Store) Get(_ context.Context, bookingID string) (domain.DecisionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rec, ok := s.byBooking[bookingID]
	if !ok {
		return domain.DecisionRecord{}, domain.ErrDecisionNotFound
	}
	return rec, nil
}

// List — витрина: свежие сверху; пустой статус — все подряд.
func (s *Store) List(_ context.Context, status domain.Status, limit int) ([]domain.DecisionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if limit <= 0 {
		limit = 200
	}
	out := make([]domain.DecisionRecord, 0, len(s.order))
	// срез растёт в порядке поступления — свежие сверху идём с конца
	for i := len(s.order) - 1; i >= 0 && len(out) < limit; i-- {
		rec := s.byBooking[s.order[i]]
		if status != "" && rec.Status != status {
			continue
		}
		out = append(out, rec)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

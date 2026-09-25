package memory

import (
	"context"
	"sync"
	"time"

	"reminder-service/internal/domain"
)

// Store — in-memory хранилище напоминаний (STORAGE=memory, тесты).
type Store struct {
	mu        sync.Mutex
	reminders []domain.Reminder
}

func NewStore() *Store { return &Store{} }

// Schedule идемпотентен по BookingID — зеркалит ON CONFLICT Postgres.
func (s *Store) Schedule(_ context.Context, r domain.Reminder) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.reminders {
		if existing.BookingID == r.BookingID {
			return nil
		}
	}
	s.reminders = append(s.reminders, r)
	return nil
}

// Cancel гасит только SCHEDULED-запись: ушедшее письмо не отозвать,
// повторная отмена — false.
func (s *Store) Cancel(_ context.Context, bookingID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.reminders {
		if r.BookingID == bookingID && r.Status == domain.StatusScheduled {
			s.reminders[i].Status = domain.StatusCancelled
			return true, nil
		}
	}
	return false, nil
}

// Due — ожидающие отправки, чей момент настал; порядок поступления.
func (s *Store) Due(_ context.Context, now time.Time) ([]domain.Reminder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.Reminder, 0)
	for _, r := range s.reminders {
		if r.Status == domain.StatusScheduled && !r.DueAt.After(now) {
			out = append(out, r)
		}
	}
	return out, nil
}

// MarkSent условен по статусу — как UPDATE ... WHERE status='SCHEDULED'.
func (s *Store) MarkSent(_ context.Context, bookingID string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, r := range s.reminders {
		if r.BookingID == bookingID && r.Status == domain.StatusScheduled {
			s.reminders[i].Status = domain.StatusSent
			s.reminders[i].RemindedAt = at
			return nil
		}
	}
	return nil
}

// List — свежими сверху (зеркалит ORDER BY id DESC витрины Postgres).
func (s *Store) List(_ context.Context) ([]domain.Reminder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]domain.Reminder, 0, len(s.reminders))
	for i := len(s.reminders) - 1; i >= 0; i-- {
		out = append(out, s.reminders[i])
	}
	return out, nil
}

var _ domain.ReminderStore = (*Store)(nil)

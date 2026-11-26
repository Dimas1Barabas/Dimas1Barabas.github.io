// Package memory — in-memory адаптеры хранилищ «Почтальона»:
// дефолт STORAGE=memory, стенд без БД жив. Конкурентный доступ —
// под мьютексом: консьюмер, тикер и витрина пишут одновременно.
// Семантика зеркалит postgres-адаптер: идемпотентность Enqueue по
// паре (подписка, событие), Replay только для delivered/dead.
package memory

import (
	"context"
	"slices"
	"sync"
	"time"

	"postman-service/internal/domain"
)

type deliveryKey struct{ subscriptionID, eventID string }

// Store — конверт двух хранилищ: подписки и доставки живут в одной
// куче, но за разными портами (у интерфейсов совпадают имена методов —
// один тип оба не реализует).
type Store struct {
	Subs       *Subscriptions
	Deliveries *Deliveries
}

// NewStore — пустое хранилище.
func NewStore() *Store {
	return &Store{Subs: &Subscriptions{subs: make(map[string]domain.Subscription)},
		Deliveries: &Deliveries{deliveries: make(map[string]domain.Delivery), seen: make(map[deliveryKey]string)}}
}

// — подписки —

// Subscriptions — память за портом SubscriptionsStore.
type Subscriptions struct {
	mu   sync.RWMutex
	subs map[string]domain.Subscription
}

func (s *Subscriptions) Add(_ context.Context, sub domain.Subscription) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subs[sub.ID] = sub
	return nil
}

func (s *Subscriptions) Get(_ context.Context, id string) (domain.Subscription, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sub, ok := s.subs[id]
	if !ok {
		return domain.Subscription{}, domain.ErrSubscriptionNotFound
	}
	return sub, nil
}

func (s *Subscriptions) Delete(_ context.Context, id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[id]; !ok {
		return false, nil
	}
	delete(s.subs, id)
	return true, nil
}

func (s *Subscriptions) List(_ context.Context) ([]domain.Subscription, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]domain.Subscription, 0, len(s.subs))
	for _, sub := range s.subs {
		out = append(out, sub)
	}
	// свежие сверху — как в postgres-адаптере
	slices.SortFunc(out, func(a, b domain.Subscription) int {
		return b.CreatedAt.Compare(a.CreatedAt)
	})
	return out, nil
}

// — доставки —

// Deliveries — память за портом DeliveriesStore.
type Deliveries struct {
	mu         sync.RWMutex
	deliveries map[string]domain.Delivery
	seen       map[deliveryKey]string // (подписка, событие) → id доставки
}

// Enqueue — идемпотентен: пара (подписка, событие) уже стояла или
// доставлялась — новая строка не заводится.
func (s *Deliveries) Enqueue(_ context.Context, batch []domain.Delivery) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, d := range batch {
		key := deliveryKey{d.SubscriptionID, d.EventID}
		if _, seen := s.seen[key]; seen {
			continue
		}
		s.deliveries[d.ID] = d
		s.seen[key] = d.ID
	}
	return nil
}

func (s *Deliveries) Due(_ context.Context, now time.Time, limit int) ([]domain.Delivery, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]domain.Delivery, 0)
	for _, d := range s.deliveries {
		if d.Status == domain.StatusQueued && !d.NextAttemptAt.After(now) {
			out = append(out, d)
		}
		if len(out) >= limit {
			break
		}
	}
	// старыми первыми — порядок как у postgres-адаптера
	slices.SortFunc(out, func(a, b domain.Delivery) int {
		return a.NextAttemptAt.Compare(b.NextAttemptAt)
	})
	return out, nil
}

func (s *Deliveries) Save(_ context.Context, d domain.Delivery) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.deliveries[d.ID]; !ok {
		return domain.ErrDeliveryNotFound
	}
	s.deliveries[d.ID] = d
	return nil
}

func (s *Deliveries) Get(_ context.Context, id string) (domain.Delivery, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.deliveries[id]
	if !ok {
		return domain.Delivery{}, domain.ErrDeliveryNotFound
	}
	return d, nil
}

// Replay — delivered/dead → queued с чистым счётчиком попыток.
func (s *Deliveries) Replay(_ context.Context, id string, now time.Time) (domain.Delivery, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.deliveries[id]
	if !ok {
		return domain.Delivery{}, domain.ErrDeliveryNotFound
	}
	if d.Status == domain.StatusQueued {
		return domain.Delivery{}, domain.ErrNotReplayable
	}
	d.Status = domain.StatusQueued
	d.Attempts = 0
	d.NextAttemptAt = now
	d.LastError = ""
	d.DeliveredAt = nil
	s.deliveries[id] = d
	return d, nil
}

func (s *Deliveries) List(_ context.Context, f domain.DeliveryFilter) ([]domain.Delivery, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]domain.Delivery, 0)
	for _, d := range s.deliveries {
		if f.SubscriptionID != "" && d.SubscriptionID != f.SubscriptionID {
			continue
		}
		if f.Status != "" && d.Status != f.Status {
			continue
		}
		out = append(out, d)
	}
	slices.SortFunc(out, func(a, b domain.Delivery) int {
		return b.CreatedAt.Compare(a.CreatedAt)
	})
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}

func (s *Deliveries) Counts(_ context.Context) (map[domain.DeliveryStatus]int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	counts := map[domain.DeliveryStatus]int{
		domain.StatusQueued:    0,
		domain.StatusDelivered: 0,
		domain.StatusDead:      0,
	}
	for _, d := range s.deliveries {
		counts[d.Status]++
	}
	return counts, nil
}

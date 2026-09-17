// Package memory — Repository-адаптер: кольцевой буфер последних
// уведомлений в памяти. Рестарт историю теряет — для демо-стенда
// честно и задокументировано; продакшен-адаптер пишет в хранилище.
package memory

import (
	"context"
	"sync"

	"notification-service/internal/domain"
)

type Repository struct {
	mu           sync.Mutex
	items        []domain.Notification
	cap          int
	defaultLimit int
}

// NewRepository — буфер на capacity записей; <=0 — 500.
func NewRepository(capacity int) *Repository {
	if capacity <= 0 {
		capacity = 500
	}
	return &Repository{cap: capacity, defaultLimit: 50}
}

// Save добавляет уведомление, вытесняя самое старое при переполнении.
func (r *Repository) Save(_ context.Context, n domain.Notification) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.items = append(r.items, n)
	if len(r.items) > r.cap {
		r.items = r.items[len(r.items)-r.cap:]
	}
	return nil
}

// List отдаёт историю: новые сверху, фильтр по брони и лимит.
func (r *Repository) List(_ context.Context, f domain.Filter) ([]domain.Notification, error) {
	if f.Limit <= 0 {
		f.Limit = r.defaultLimit
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	out := make([]domain.Notification, 0, len(r.items))
	for i := len(r.items) - 1; i >= 0 && len(out) < f.Limit; i-- {
		if f.BookingID == "" || r.items[i].BookingID == f.BookingID {
			out = append(out, r.items[i])
		}
	}
	return out, nil
}

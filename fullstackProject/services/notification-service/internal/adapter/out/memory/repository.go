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
	seen         map[string]struct{} // ID записанных — дедуп ределивери
	cap          int
	defaultLimit int
}

// NewRepository — буфер на capacity записей; <=0 — 500.
func NewRepository(capacity int) *Repository {
	if capacity <= 0 {
		capacity = 500
	}
	return &Repository{seen: map[string]struct{}{}, cap: capacity, defaultLimit: 50}
}

// Exists — был ли такой ID (дедуп ределивери до отправки).
func (r *Repository) Exists(_ context.Context, id string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.seen[id]
	return ok, nil
}

// Save добавляет уведомление, вытесняя самое старое при переполнении.
// Дубль по ID (ределивери) не записывается — false.
func (r *Repository) Save(_ context.Context, n domain.Notification) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, dup := r.seen[n.ID]; dup {
		return false, nil
	}
	r.items = append(r.items, n)
	if len(r.items) > r.cap {
		delete(r.seen, r.items[0].ID)
		r.items = r.items[1:]
	}
	r.seen[n.ID] = struct{}{}
	return true, nil
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

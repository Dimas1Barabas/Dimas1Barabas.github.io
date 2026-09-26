// Package memory — BucketStore в памяти процесса: дефолт, стенд без
// Postgres не падает. Рестарт обнуляет корзины — для лимитов это
// осознанно: злоумышленник получит свежую корзину, но не окно.
package memory

import (
	"context"
	"sync"
	"time"

	"ratelimiter-service/internal/domain"
)

var _ domain.BucketStore = (*Store)(nil)

// Store — карта корзин под мьютексом: Take — это буквально вызов
// чистой функции домена, атомарность даёт блокировка.
type Store struct {
	mu      sync.Mutex
	buckets map[string]domain.Bucket
}

// NewStore — пустое хранилище.
func NewStore() *Store {
	return &Store{buckets: make(map[string]domain.Bucket)}
}

// Take — долив + попытка списания одним шагом под мьютексом.
func (s *Store) Take(_ context.Context, action domain.Action, key string, p domain.Policy) (bool, float64, error) {
	id := string(action) + ":" + key
	s.mu.Lock()
	defer s.mu.Unlock()

	var current *domain.Bucket
	if b, ok := s.buckets[id]; ok {
		current = &b
	}
	next, decision := domain.Check(current, time.Now(), p.Capacity, p.RefillPerSec)
	s.buckets[id] = next
	return decision.Allowed, decision.Remaining, nil
}

// ListBuckets — срез корзин для витрины, свежие сверху.
func (s *Store) ListBuckets(_ context.Context) ([]domain.BucketRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]domain.BucketRecord, 0, len(s.buckets))
	for id, b := range s.buckets {
		action, key, found := cutString(id, ':')
		if !found {
			continue // теоретически невозможно: ключ всегда с двоеточием
		}
		out = append(out, domain.BucketRecord{
			Action:    action,
			Key:       key,
			Tokens:    b.Tokens,
			Taken:     b.LastTaken,
			UpdatedAt: b.UpdatedAt,
		})
	}
	// свежие сверху — витрине интересно, что происходило только что
	sortByUpdatedDesc(out)
	return out, nil
}

// cutString — делит строку по первому вхождению байта.
func cutString(s string, sep byte) (string, string, bool) {
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			return s[:i], s[i+1:], true
		}
	}
	return s, "", false
}

func sortByUpdatedDesc(rows []domain.BucketRecord) {
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rows[j].UpdatedAt.After(rows[j-1].UpdatedAt); j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}
}

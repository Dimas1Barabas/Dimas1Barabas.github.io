// Package memory — in-memory адаптер хранилища очереди: дефолт
// STORAGE=memory, стенд без БД жив. Конкурентный доступ — под
// мьютексом: кнопки витрины и консьюмер пишут одновременно.
package memory

import (
	"context"
	"slices"
	"sync"

	"barman-service/internal/domain"
)

type Store struct {
	mu     sync.RWMutex
	orders map[string]domain.Order
}

func NewStore() *Store {
	return &Store{orders: make(map[string]domain.Order)}
}

// Upsert — идемпотентен по OrderID: существующий заказ не трогаем,
// ределивери bar.order.created не сбрасывает прогресс очереди.
func (s *Store) Upsert(_ context.Context, o domain.Order) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.orders[o.OrderID]; exists {
		return nil
	}
	s.orders[o.OrderID] = o
	return nil
}

func (s *Store) Get(_ context.Context, orderID string) (domain.Order, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	o, ok := s.orders[orderID]
	if !ok {
		return domain.Order{}, domain.ErrOrderNotFound
	}
	return o, nil
}

func (s *Store) Save(_ context.Context, o domain.Order) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.orders[o.OrderID]; !ok {
		return domain.ErrOrderNotFound
	}
	s.orders[o.OrderID] = o
	return nil
}

// Board — колонки экрана бара: активные по времени приёма, Recent —
// закрытые (выдано/отменено) сверху свежие, лимит 20.
func (s *Store) Board(_ context.Context) (domain.Board, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	board := domain.Board{
		New:       []domain.Order{},
		Preparing: []domain.Order{},
		Ready:     []domain.Order{},
		Recent:    []domain.Order{},
	}
	for _, o := range s.orders {
		switch o.Status {
		case domain.StatusNew:
			board.New = append(board.New, o)
		case domain.StatusPreparing:
			board.Preparing = append(board.Preparing, o)
		case domain.StatusReady:
			board.Ready = append(board.Ready, o)
		default: // PICKED_UP, CANCELLED
			board.Recent = append(board.Recent, o)
		}
	}
	byCreatedAsc := func(a, b domain.Order) int {
		return a.CreatedAt.Compare(b.CreatedAt)
	}
	slices.SortFunc(board.New, byCreatedAsc)
	slices.SortFunc(board.Preparing, byCreatedAsc)
	slices.SortFunc(board.Ready, byCreatedAsc)
	slices.SortFunc(board.Recent, func(a, b domain.Order) int {
		return b.ChangedAt.Compare(a.ChangedAt) // свежие сверху
	})
	if len(board.Recent) > 20 {
		board.Recent = board.Recent[:20]
	}
	return board, nil
}

var _ domain.OrderStore = (*Store)(nil)

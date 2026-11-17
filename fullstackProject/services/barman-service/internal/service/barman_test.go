package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"barman-service/internal/domain"
)

// fakeStore — Map-хранилище с журналом публикаций.
type fakeStore struct {
	orders map[string]domain.Order
}

func (s *fakeStore) Upsert(_ context.Context, o domain.Order) error {
	if _, ok := s.orders[o.OrderID]; ok {
		return nil // как ON CONFLICT DO NOTHING
	}
	s.orders[o.OrderID] = o
	return nil
}

func (s *fakeStore) Get(_ context.Context, id string) (domain.Order, error) {
	o, ok := s.orders[id]
	if !ok {
		return domain.Order{}, domain.ErrOrderNotFound
	}
	return o, nil
}

func (s *fakeStore) Save(_ context.Context, o domain.Order) error {
	if _, ok := s.orders[o.OrderID]; !ok {
		return domain.ErrOrderNotFound
	}
	s.orders[o.OrderID] = o
	return nil
}

func (s *fakeStore) Board(_ context.Context) (domain.Board, error) {
	return domain.Board{}, nil
}

// fakePublisher — журнал статусов; ломкий режим проверяет репаблиш.
type fakePublisher struct {
	events []domain.Order
	fail   bool
}

func (p *fakePublisher) PublishStatus(_ context.Context, o domain.Order) error {
	if p.fail {
		return errors.New("брокер недоступен")
	}
	p.events = append(p.events, o)
	return nil
}

type frozenClock struct{ at time.Time }

func (c frozenClock) Now() time.Time { return c.at }

func newBarman(store *fakeStore, pub *fakePublisher) *Barman {
	return NewBarman(store, pub).WithClock(frozenClock{at: time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)})
}

func accepted() domain.Order {
	return domain.Order{
		OrderID:      "order-1",
		UserID:       "user-a",
		Email:        "anna@test.local",
		CustomerName: "Анна",
		Items:        []domain.Item{{ItemID: "i1", Name: "Попкорн солёный", PriceRub: 320, Qty: 1}},
		TotalRub:     320,
	}
}

// Приём идемпотентен: ределивери created не сбрасывает прогресс
// (PREPARING остаётся PREPARING) и не плодит записей.
func TestAcceptIdempotent(t *testing.T) {
	store := &fakeStore{orders: map[string]domain.Order{}}
	b := newBarman(store, &fakePublisher{})
	ctx := context.Background()

	if err := b.Accept(ctx, accepted()); err != nil {
		t.Fatalf("первый приём: %v", err)
	}
	if _, err := b.Start(ctx, "order-1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := b.Accept(ctx, accepted()); err != nil {
		t.Fatalf("ределивери: %v", err)
	}
	got, _ := store.Get(ctx, "order-1")
	if got.Status != domain.StatusPreparing {
		t.Fatalf("ределивери сбросил прогресс: %s", got.Status)
	}
}

// Кнопки идут по циклу, каждый шаг публикует статус.
func TestButtonsLifecycle(t *testing.T) {
	store := &fakeStore{orders: map[string]domain.Order{}}
	pub := &fakePublisher{}
	b := newBarman(store, pub)
	ctx := context.Background()
	_ = b.Accept(ctx, accepted())

	for _, step := range []struct {
		name string
		call func(ctx context.Context, id string) (domain.Order, error)
		want domain.Status
	}{
		{"start", b.Start, domain.StatusPreparing},
		{"ready", b.Ready, domain.StatusReady},
		{"pickup", b.PickUp, domain.StatusPickedUp},
	} {
		o, err := step.call(ctx, "order-1")
		if err != nil {
			t.Fatalf("шаг %s: %v", step.name, err)
		}
		if o.Status != step.want {
			t.Fatalf("статус %s, ожидался %s", o.Status, step.want)
		}
	}
	wantStatuses := []domain.Status{domain.StatusPreparing, domain.StatusReady, domain.StatusPickedUp}
	if len(pub.events) != len(wantStatuses) {
		t.Fatalf("публикаций %d, ожидалось %d", len(pub.events), len(wantStatuses))
	}
	for i, want := range wantStatuses {
		if pub.events[i].Status != want {
			t.Fatalf("публикация %d: %s, ожидался %s", i, pub.events[i].Status, want)
		}
	}
}

// Сбой публикации не теряет прогресс: статус сохранён, повторный клик
// репаблишит событие без ошибки перехода.
func TestPublishFailureRepublishOnRepeat(t *testing.T) {
	store := &fakeStore{orders: map[string]domain.Order{}}
	pub := &fakePublisher{fail: true}
	b := newBarman(store, pub)
	ctx := context.Background()
	_ = b.Accept(ctx, accepted())

	if _, err := b.Start(ctx, "order-1"); err == nil {
		t.Fatal("первый клик должен был споткнуться о публикацию")
	}
	// прогресс зафиксирован локально
	got, _ := store.Get(ctx, "order-1")
	if got.Status != domain.StatusPreparing {
		t.Fatalf("статус %s, ожидался PREPARING (save-then-publish)", got.Status)
	}

	// брокер ожил, повторный клик — репаблиш
	pub.fail = false
	if _, err := b.Start(ctx, "order-1"); err != nil {
		t.Fatalf("повторный клик: %v", err)
	}
	if len(pub.events) != 1 || pub.events[0].Status != domain.StatusPreparing {
		t.Fatalf("репаблиш не ушёл: %+v", pub.events)
	}
}

// Отмена: неизвестный заказ гасится молча (событие обогнало created).
func TestCancelUnknownOrderIsSilent(t *testing.T) {
	store := &fakeStore{orders: map[string]domain.Order{}}
	b := newBarman(store, &fakePublisher{})
	if err := b.Cancel(context.Background(), "no-such"); err != nil {
		t.Fatalf("отмена неизвестного заказа — не ошибка: %v", err)
	}
}

// Готовность несёт адресата «письма»: email едет в статус-событии.
func TestStatusEventCarriesEmail(t *testing.T) {
	store := &fakeStore{orders: map[string]domain.Order{}}
	pub := &fakePublisher{}
	b := newBarman(store, pub)
	ctx := context.Background()
	_ = b.Accept(ctx, accepted())

	if _, err := b.Start(ctx, "order-1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := b.Ready(ctx, "order-1"); err != nil {
		t.Fatalf("ready: %v", err)
	}
	last := pub.events[len(pub.events)-1]
	if last.Email != "anna@test.local" || last.CustomerName != "Анна" {
		t.Fatalf("статус-событие без адресата: %+v", last)
	}
}

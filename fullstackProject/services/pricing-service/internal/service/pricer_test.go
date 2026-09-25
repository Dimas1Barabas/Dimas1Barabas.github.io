package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"pricing-service/internal/domain"
)

// fakeStore — предсказуемый двойник хранилища: спрос по сеансам
// и отказ по требованию (транзиентный сбой).
type fakeStore struct {
	demand     map[string]int
	held       []string
	released   []string
	logged     []domain.Quote
	failDemand bool
}

func (f *fakeStore) ApplyHeld(_ context.Context, sessionID, bookingID string, seats int) (bool, error) {
	f.held = append(f.held, bookingID)
	f.demand[sessionID] += seats
	return true, nil
}

func (f *fakeStore) ApplyReleased(_ context.Context, sessionID, bookingID string, seats int) (bool, error) {
	f.released = append(f.released, bookingID)
	if v := f.demand[sessionID] - seats; v > 0 {
		f.demand[sessionID] = v
	} else {
		f.demand[sessionID] = 0
	}
	return true, nil
}

func (f *fakeStore) Demand(_ context.Context, sessionID string) (int, error) {
	if f.failDemand {
		return 0, errors.New("хранилище недоступно")
	}
	return f.demand[sessionID], nil
}

func (f *fakeStore) LogQuote(_ context.Context, sessionID string, q domain.Quote) error {
	f.logged = append(f.logged, q)
	return nil
}

func (f *fakeStore) ListQuotes(_ context.Context) ([]domain.QuoteRecord, error) { return nil, nil }
func (f *fakeStore) ListDemand(_ context.Context) ([]domain.DemandRecord, error) {
	return nil, nil
}

func TestQuoteReadsDemandAndLogs(t *testing.T) {
	store := &fakeStore{demand: map[string]int{"s-1": 70}} // 87% — аншлаг
	p := NewPricer(store)

	q, err := p.Quote(context.Background(), QuoteRequest{
		SessionID:    "s-1",
		SessionAt:    time.Date(2026, time.September, 22, 14, 0, 0, 0, time.Local),
		BasePriceRub: 400,
		Capacity:     80,
	})
	if err != nil {
		t.Fatal(err)
	}
	if q.PriceRub != 500 { // 400 × 1.25
		t.Fatalf("price = %d, want 500", q.PriceRub)
	}
	if len(store.logged) != 1 || store.logged[0].PriceRub != 500 {
		t.Fatalf("квот не записан в витрину: %+v", store.logged)
	}
}

func TestQuoteStoreFailureIsError(t *testing.T) {
	p := NewPricer(&fakeStore{demand: map[string]int{}, failDemand: true})
	if _, err := p.Quote(context.Background(), QuoteRequest{
		SessionID:    "s-1",
		SessionAt:    time.Now(),
		BasePriceRub: 400,
		Capacity:     80,
	}); err == nil {
		t.Fatal("сбой хранилища должен быть ошибкой — вызывающий ответит fallback'ом")
	}
}

func TestQuoteInvalidInput(t *testing.T) {
	p := NewPricer(&fakeStore{demand: map[string]int{}})
	if _, err := p.Quote(context.Background(), QuoteRequest{
		SessionID:    "s-1",
		SessionAt:    time.Now(),
		BasePriceRub: 0,
		Capacity:     80,
	}); !errors.Is(err, domain.ErrInvalidQuote) {
		t.Fatalf("err = %v, want ErrInvalidQuote", err)
	}
}

func TestHandleHeldAndReleased(t *testing.T) {
	store := &fakeStore{demand: map[string]int{}}
	p := NewPricer(store)
	ctx := context.Background()

	if err := p.HandleHeld(ctx, "s-1", "b-1", 3); err != nil {
		t.Fatal(err)
	}
	if err := p.HandleHeld(ctx, "s-1", "b-2", 2); err != nil {
		t.Fatal(err)
	}
	if got := store.demand["s-1"]; got != 5 {
		t.Fatalf("demand = %d, want 5", got)
	}
	if err := p.HandleReleased(ctx, "s-1", "b-1", 3); err != nil {
		t.Fatal(err)
	}
	if got := store.demand["s-1"]; got != 2 {
		t.Fatalf("demand = %d, want 2", got)
	}
}

func TestHandleGarbageEvents(t *testing.T) {
	p := NewPricer(&fakeStore{demand: map[string]int{}})
	ctx := context.Background()
	for _, tc := range []struct {
		name                 string
		sessionID, bookingID string
		seats                int
	}{
		{"нет сеанса", "", "b-1", 2},
		{"нет брони", "s-1", "", 2},
		{"нулевые места", "s-1", "b-1", 0},
	} {
		if err := p.HandleHeld(ctx, tc.sessionID, tc.bookingID, tc.seats); !errors.Is(err, domain.ErrInvalidDemandEvent) {
			t.Fatalf("%s: err = %v, want ErrInvalidDemandEvent", tc.name, err)
		}
		if err := p.HandleReleased(ctx, tc.sessionID, tc.bookingID, tc.seats); !errors.Is(err, domain.ErrInvalidDemandEvent) {
			t.Fatalf("%s: err = %v, want ErrInvalidDemandEvent", tc.name, err)
		}
	}
}

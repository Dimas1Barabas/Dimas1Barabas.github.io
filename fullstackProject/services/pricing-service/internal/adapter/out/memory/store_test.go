package memory

import (
	"context"
	"testing"
	"time"

	"pricing-service/internal/domain"
)

func TestHeldAccumulatesAndDedups(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	if _, err := s.ApplyHeld(ctx, "s-1", "b-1", 3); err != nil {
		t.Fatal(err)
	}
	// redelivery того же события — дубль, спрос не задваивается
	applied, err := s.ApplyHeld(ctx, "s-1", "b-1", 3)
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("дубль held должен быть no-op")
	}
	if _, err := s.ApplyHeld(ctx, "s-1", "b-2", 2); err != nil {
		t.Fatal(err)
	}
	got, err := s.Demand(ctx, "s-1")
	if err != nil {
		t.Fatal(err)
	}
	if got != 5 {
		t.Fatalf("demand = %d, want 5", got)
	}
}

func TestReleasedFloorsAtZero(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	// освобождения без held (событие held потеряно) — не в минус
	if _, err := s.ApplyReleased(ctx, "s-1", "b-1", 4); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Demand(ctx, "s-1"); got != 0 {
		t.Fatalf("demand = %d, want 0", got)
	}
	if _, err := s.ApplyHeld(ctx, "s-1", "b-2", 6); err != nil {
		t.Fatal(err)
	}
	// освободили больше, чем держала эта бронь (дрейф) — clamp в 0
	if _, err := s.ApplyReleased(ctx, "s-1", "b-3", 9); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Demand(ctx, "s-1"); got != 0 {
		t.Fatalf("demand = %d, want 0", got)
	}
}

func TestUnknownSessionDemandZero(t *testing.T) {
	s := NewStore()
	got, err := s.Demand(context.Background(), "нет-такого")
	if err != nil {
		t.Fatal(err)
	}
	if got != 0 {
		t.Fatalf("demand = %d, want 0", got)
	}
}

func TestQuotesShowcaseFreshFirst(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	// два квота — витрина отдаёт свежим сверху
	for _, base := range []int{400, 450} {
		q, err := domain.ComputeQuote(time.Date(2026, time.September, 22, 19, 0, 0, 0, time.Local), base, 70, 80)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.LogQuote(ctx, "s-1", q); err != nil {
			t.Fatal(err)
		}
	}
	quotes, err := s.ListQuotes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(quotes) != 2 || quotes[0].BasePriceRub != 450 {
		t.Fatalf("витрина = %+v, want свежий (450) сверху", quotes)
	}
	if quotes[0].Factors == "" {
		t.Fatalf("раскладка факторов пуста: %+v", quotes[0])
	}
}

func TestDemandShowcaseSorted(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	for _, id := range []string{"s-3", "s-1", "s-2"} {
		if _, err := s.ApplyHeld(ctx, id, "b-"+id, 1); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := s.ListDemand(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[0].SessionID != "s-1" || rows[2].SessionID != "s-3" {
		t.Fatalf("витрина = %+v, want по sessionID", rows)
	}
}

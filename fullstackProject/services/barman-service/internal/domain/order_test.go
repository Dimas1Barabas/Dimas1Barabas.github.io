package domain

import (
	"errors"
	"testing"
	"time"
)

func newOrder() Order {
	return Order{
		OrderID:      "order-1",
		CustomerName: "Анна",
		Items:        []Item{{ItemID: "i1", Name: "Попкорн солёный", PriceRub: 320, Qty: 2}},
		TotalRub:     640,
		Status:       StatusNew,
	}
}

// Счастливый путь: NEW → PREPARING → READY → PICKED_UP.
func TestLifecycleHappyPath(t *testing.T) {
	o := newOrder()
	for _, step := range []struct {
		name string
		call func() error
		want Status
	}{
		{"в работу", o.Start, StatusPreparing},
		{"готов", o.Ready, StatusReady},
		{"выдан", o.PickUp, StatusPickedUp},
	} {
		if err := step.call(); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		if o.Status != step.want {
			t.Fatalf("%s: статус %s, ожидался %s", step.name, o.Status, step.want)
		}
	}
}

// Пропуск шага невозможен: готовить выданное, выдать сырое.
func TestInvalidTransitions(t *testing.T) {
	t.Run("выдать не подготовленное", func(t *testing.T) {
		o := newOrder() // NEW
		if err := o.PickUp(); !errors.Is(err, ErrInvalidTransition) {
			t.Fatalf("ожидался ErrInvalidTransition, получено %v", err)
		}
	})
	t.Run("готовить неоткуда", func(t *testing.T) {
		o := newOrder()
		_ = o.Start()
		_ = o.Ready()
		if err := o.Start(); !errors.Is(err, ErrInvalidTransition) {
			t.Fatalf("ожидался ErrInvalidTransition, получено %v", err)
		}
	})
}

// Отмена: живой заказ снимается, дубль — идемпотентно тихо,
// выданное отменить нельзя.
func TestCancel(t *testing.T) {
	t.Run("NEW снимается", func(t *testing.T) {
		o := newOrder()
		if err := o.Cancel(); err != nil {
			t.Fatalf("отмена NEW: %v", err)
		}
		if o.Status != StatusCancelled {
			t.Fatalf("статус %s, ожидался CANCELLED", o.Status)
		}
	})
	t.Run("дубль отмены тихо гасится", func(t *testing.T) {
		o := newOrder()
		_ = o.Cancel()
		if err := o.Cancel(); err != nil {
			t.Fatalf("повторная отмена — не ошибка: %v", err)
		}
	})
	t.Run("выданное не отменяется", func(t *testing.T) {
		o := newOrder()
		_ = o.Start()
		_ = o.Ready()
		_ = o.PickUp()
		if err := o.Cancel(); !errors.Is(err, ErrInvalidTransition) {
			t.Fatalf("ожидался ErrInvalidTransition, получено %v", err)
		}
	})
}

func TestSummaryAndSessionLabel(t *testing.T) {
	o := Order{
		Items: []Item{
			{ItemID: "i1", Name: "Попкорн солёный", PriceRub: 320, Qty: 2},
			{ItemID: "i2", Name: "Кола 0,5 л", PriceRub: 220, Qty: 1},
		},
		TotalRub: 860,
	}
	if got, want := o.Summary(), "Попкорн солёный×2, Кола 0,5 л×1 — 860 ₽"; got != want {
		t.Fatalf("Summary() = %q, ожидалась %q", got, want)
	}
	if got, want := o.SessionLabel(), "без сеанса"; got != want {
		t.Fatalf("SessionLabel() без сеанса = %q, ожидалась %q", got, want)
	}
	o.Hall = "IMAX"
	o.SessionAt = time.Date(2026, 11, 20, 19, 30, 0, 0, time.UTC)
	o.SessionID = "s-1"
	if got, want := o.SessionLabel(), "IMAX, Fri 19:30"; got != want {
		t.Fatalf("SessionLabel() с сеансом = %q, ожидалась %q", got, want)
	}
}

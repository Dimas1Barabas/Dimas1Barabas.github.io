package processing

import (
	"testing"
	"time"

	"ticket-worker/internal/events"
)

func testProcessor() *Processor {
	// миллисекундные задержки — тесты не спят по две секунды
	return &Processor{
		WorkerID:          "go-worker-test",
		PayMin:            time.Millisecond,
		PayMax:            2 * time.Millisecond,
		PaySuccessRate:    1,
		RefundMin:         time.Millisecond,
		RefundMax:         2 * time.Millisecond,
		RefundSuccessRate: 1,
	}
}

func TestExpired(t *testing.T) {
	p := testProcessor()
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	ev := events.BookingPaymentTimeout{BookingID: "booking-42"}

	got := p.Expired(ev, now)

	if got.BookingID != ev.BookingID {
		t.Fatalf("bookingId = %q, want %q", got.BookingID, ev.BookingID)
	}
	if got.ProcessedBy != p.WorkerID {
		t.Fatalf("processedBy = %q, want %q", got.ProcessedBy, p.WorkerID)
	}
	if got.Message == "" {
		t.Fatal("message пуст — API покажет его пользователю")
	}
	// API читает expiredAt как ISO-дату (new Date(...))
	parsed, err := time.Parse(time.RFC3339, got.ExpiredAt)
	if err != nil {
		t.Fatalf("expiredAt не RFC3339: %v", err)
	}
	if !parsed.Equal(now) {
		t.Fatalf("expiredAt = %v, want %v", parsed, now)
	}
}

func TestProcessVerdicts(t *testing.T) {
	ev := events.BookingCreated{
		BookingID: "b-1", MovieTitle: "Тест", Seats: []string{"5-7"}, TotalRub: 500,
	}

	t.Run("ставка 1 — всегда CONFIRMED", func(t *testing.T) {
		p := testProcessor()
		for range 5 {
			if got := p.Process(ev); got.Status != "CONFIRMED" {
				t.Fatalf("status = %q, want CONFIRMED", got.Status)
			}
		}
	})

	t.Run("ставка 0 — всегда FAILED", func(t *testing.T) {
		p := testProcessor()
		p.PaySuccessRate = 0
		for range 5 {
			got := p.Process(ev)
			if got.Status != "FAILED" {
				t.Fatalf("status = %q, want FAILED", got.Status)
			}
			if got.ProcessedBy != p.WorkerID {
				t.Fatalf("processedBy = %q, want %q", got.ProcessedBy, p.WorkerID)
			}
		}
	})
}

func TestRefundVerdicts(t *testing.T) {
	ev := events.BookingCancelled{
		BookingID: "b-2", MovieTitle: "Тест", Seats: []string{"1-2"}, TotalRub: 300,
	}

	t.Run("ставка 1 — CANCELLED", func(t *testing.T) {
		p := testProcessor()
		got := p.Refund(ev)
		if got.Status != "CANCELLED" {
			t.Fatalf("status = %q, want CANCELLED", got.Status)
		}
	})

	t.Run("ставка 0 — REFUND_FAILED", func(t *testing.T) {
		p := testProcessor()
		p.RefundSuccessRate = 0
		got := p.Refund(ev)
		if got.Status != "REFUND_FAILED" {
			t.Fatalf("status = %q, want REFUND_FAILED", got.Status)
		}
	})
}

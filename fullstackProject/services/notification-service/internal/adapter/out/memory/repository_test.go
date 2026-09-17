package memory

import (
	"context"
	"testing"
	"time"

	"notification-service/internal/domain"
)

func saveAt(t *testing.T, r *Repository, bookingID, verdict string, at time.Time) {
	t.Helper()
	n, err := domain.NewFromOutcome(domain.Outcome{BookingID: bookingID, Verdict: verdict}, at)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Save(context.Background(), n); err != nil {
		t.Fatal(err)
	}
}

func TestRepositoryListNewestFirst(t *testing.T) {
	r := NewRepository(0) // 0 → дефолт 500
	base := time.Date(2026, 9, 17, 9, 0, 0, 0, time.UTC)

	saveAt(t, r, "b-1", "CONFIRMED", base)
	saveAt(t, r, "b-2", "EXPIRED", base.Add(time.Second))

	items, err := r.List(context.Background(), domain.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 || items[0].BookingID != "b-2" || items[1].BookingID != "b-1" {
		t.Fatalf("порядок: %v, want [b-2 b-1]", items)
	}
}

func TestRepositoryFilterAndLimit(t *testing.T) {
	r := NewRepository(0)
	base := time.Date(2026, 9, 17, 9, 0, 0, 0, time.UTC)

	for i, booking := range []string{"b-1", "b-1", "b-2"} {
		saveAt(t, r, booking, "CONFIRMED", base.Add(time.Duration(i)*time.Second))
	}

	byBooking, _ := r.List(context.Background(), domain.Filter{BookingID: "b-1"})
	if len(byBooking) != 2 {
		t.Fatalf("по брони b-1 = %d записей, want 2", len(byBooking))
	}

	limited, _ := r.List(context.Background(), domain.Filter{Limit: 2})
	if len(limited) != 2 || limited[0].BookingID != "b-2" {
		t.Fatalf("лимит 2: %v", limited)
	}
}

func TestRepositoryEvictsOldest(t *testing.T) {
	r := NewRepository(2)
	base := time.Date(2026, 9, 17, 9, 0, 0, 0, time.UTC)

	for i, booking := range []string{"old", "mid", "new"} {
		saveAt(t, r, booking, "CONFIRMED", base.Add(time.Duration(i)*time.Second))
	}

	items, _ := r.List(context.Background(), domain.Filter{})
	if len(items) != 2 || items[1].BookingID != "mid" || items[0].BookingID != "new" {
		t.Fatalf("буфер вытесняет старое: %v, want [new mid]", items)
	}
}

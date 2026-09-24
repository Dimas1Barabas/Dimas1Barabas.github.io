package memory

import (
	"context"
	"testing"

	"recommendation-service/internal/domain"
)

func TestStoreDedup(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	sig := domain.Signal{UserID: "u1", MovieID: "m1", Genre: "драма", Kind: domain.KindBooking, DedupKey: "booking:b1"}
	if err := s.Append(ctx, sig); err != nil {
		t.Fatalf("Append: %v", err)
	}
	if err := s.Append(ctx, sig); err != nil {
		t.Fatalf("повторный Append: %v", err)
	}
	got, err := s.List(ctx, "u1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("сигналов = %d, want 1 (дедуп по DedupKey)", len(got))
	}
}

func TestStoreListFiltersByUser(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	_ = s.Append(ctx, domain.Signal{UserID: "u1", MovieID: "m1", Genre: "драма", Kind: domain.KindBooking, DedupKey: "booking:b1"})
	_ = s.Append(ctx, domain.Signal{UserID: "u2", MovieID: "m2", Genre: "хоррор", Kind: domain.KindBooking, DedupKey: "booking:b2"})

	got, err := s.List(ctx, "u2")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0].UserID != "u2" {
		t.Fatalf("List(u2) = %+v, want один сигнал u2", got)
	}

	empty, err := s.List(ctx, "никого")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("List(нет зрителя) = %v, want пустой непустой-nil слайс", empty)
	}
}

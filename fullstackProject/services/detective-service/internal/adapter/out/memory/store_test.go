package memory

import (
	"context"
	"errors"
	"testing"
	"time"

	"detective-service/internal/domain"
)

var t40 = domain.Thresholds{Review: 40, Block: 70}

func allow() domain.Facts {
	return domain.Facts{BookingID: "b-calm", UserID: "u-1", SeatsCount: 2, TotalRub: 800, AccountAgeDays: 30}
}

func review() domain.Facts {
	return domain.Facts{BookingID: "b-fast", UserID: "u-2", SeatsCount: 2, TotalRub: 800,
		AccountAgeDays: 0, Bookings24h: 5}
}

func TestSaveIdempotent(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	first, err := s.Save(ctx, domain.Score(review(), t40))
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != domain.StatusPendingReview {
		t.Fatalf("статус = %s, хочу pending_review", first.Status)
	}
	// факты «изменились» (скор стал block) — решение не пересматривается
	changed := review()
	changed.Bookings24h = 20
	second, err := s.Save(ctx, domain.Score(changed, t40))
	if err != nil {
		t.Fatal(err)
	}
	if second.Score != first.Score || second.Verdict != first.Verdict {
		t.Fatalf("повторный Score пересмотрел решение: %+v vs %+v", second, first)
	}
}

func TestResolveLifecycle(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	if _, err := s.Resolve(ctx, "нет-такой", domain.ResolveApprove, "admin@test.local"); !errors.Is(err, domain.ErrDecisionNotFound) {
		t.Fatalf("чужой booking_id: err = %v, хочу NotFound", err)
	}

	if _, err := s.Save(ctx, domain.Score(review(), t40)); err != nil {
		t.Fatal(err)
	}
	// allow-решения в очередь ревью не попадают — резолвить нельзя
	if _, err := s.Save(ctx, domain.Score(allow(), t40)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve(ctx, "b-calm", domain.ResolveApprove, "admin@test.local"); !errors.Is(err, domain.ErrAlreadyResolved) {
		t.Fatalf("авто-allow под резолвом: err = %v, хочу AlreadyResolved", err)
	}

	rec, err := s.Resolve(ctx, "b-fast", domain.ResolveApprove, "admin@test.local")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Status != domain.StatusApproved || rec.ResolvedBy != "admin@test.local" {
		t.Fatalf("резолв: %+v", rec)
	}
	if rec.ResolvedAt.IsZero() {
		t.Fatal("ResolvedAt не проставлен")
	}
	// второй админ опоздал
	if _, err := s.Resolve(ctx, "b-fast", domain.ResolveReject, "admin2@test.local"); !errors.Is(err, domain.ErrAlreadyResolved) {
		t.Fatalf("повторный резолв: err = %v, хочу AlreadyResolved", err)
	}
}

func TestListFreshFirstWithFilter(t *testing.T) {
	s := NewStore()
	base := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }
	ctx := context.Background()

	if _, err := s.Save(ctx, domain.Score(allow(), t40)); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return base.Add(time.Minute) }
	fresh := review()
	fresh.BookingID = "b-fast-2"
	if _, err := s.Save(ctx, domain.Score(fresh, t40)); err != nil {
		t.Fatal(err)
	}

	all, err := s.List(ctx, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].Facts.BookingID != "b-fast-2" {
		t.Fatalf("витрина должна идти свежими сверху: %+v", all)
	}

	pending, err := s.List(ctx, domain.StatusPendingReview, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Status != domain.StatusPendingReview {
		t.Fatalf("фильтр очереди ревью: %+v", pending)
	}

	one, err := s.List(ctx, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 1 {
		t.Fatalf("limit не режет хвост: %+v", one)
	}
}

func TestGet(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	if _, err := s.Get(ctx, "нет"); !errors.Is(err, domain.ErrDecisionNotFound) {
		t.Fatalf("err = %v, хочу NotFound", err)
	}
	if _, err := s.Save(ctx, domain.Score(allow(), t40)); err != nil {
		t.Fatal(err)
	}
	rec, err := s.Get(ctx, "b-calm")
	if err != nil || rec.Verdict != domain.VerdictAllow {
		t.Fatalf("get: rec=%+v err=%v", rec, err)
	}
}

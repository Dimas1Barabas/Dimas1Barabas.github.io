package service

import (
	"context"
	"errors"
	"testing"

	"detective-service/internal/adapter/out/memory"
	"detective-service/internal/domain"
)

var t40 = domain.Thresholds{Review: 40, Block: 70}

// Score оркестрирует домен и хранилище: решение посчитано, записано,
// статус стартует из вердикта
func TestScoreSavesDecision(t *testing.T) {
	svc := NewDetective(memory.NewStore(), t40)
	rec, err := svc.Score(context.Background(), domain.Facts{
		BookingID: "b-1", UserID: "u-1", AccountAgeDays: 0, Bookings24h: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if rec.Verdict != domain.VerdictReview || rec.Status != domain.StatusPendingReview || rec.Score != 55 {
		t.Fatalf("решение: %+v", rec)
	}
}

// неизвестное действие резолва отсеивается сервисом до хранилища
func TestResolveValidatesAction(t *testing.T) {
	svc := NewDetective(memory.NewStore(), t40)
	if _, err := svc.Resolve(context.Background(), "b-1", "помиловать", "admin@test.local"); !errors.Is(err, domain.ErrUnknownResolveAction) {
		t.Fatalf("err = %v, хочу ErrUnknownResolveAction", err)
	}
}

// List проксирует фильтр статуса: пустой — все решения подряд
func TestListAllWithEmptyStatus(t *testing.T) {
	svc := NewDetective(memory.NewStore(), t40)
	ctx := context.Background()
	for _, f := range []domain.Facts{
		{BookingID: "b-1", AccountAgeDays: 30},
		{BookingID: "b-2", AccountAgeDays: 0, Bookings24h: 5},
	} {
		if _, err := svc.Score(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	all, err := svc.List(ctx, "", 0)
	if err != nil || len(all) != 2 {
		t.Fatalf("list: %+v err=%v", all, err)
	}
	pending, err := svc.List(ctx, string(domain.StatusPendingReview), 0)
	if err != nil || len(pending) != 1 {
		t.Fatalf("очередь: %+v err=%v", pending, err)
	}
}

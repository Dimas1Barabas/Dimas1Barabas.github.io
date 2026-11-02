package memory

import (
	"context"
	"testing"
	"time"

	"flags-service/internal/domain"
)

func TestStoreLifecycle(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	if _, found, _ := s.Get(ctx, "no.flag"); found {
		t.Fatalf("пустое хранилище не должно находить флаги")
	}

	f1 := domain.Flag{Key: "demo.audience", Enabled: true, Percentage: 100, UpdatedBy: "admin", UpdatedAt: time.Now()}
	f2 := domain.Flag{Key: "checkout.new_flow", Enabled: false, Percentage: 10, UpdatedBy: "qa", UpdatedAt: time.Now()}
	if err := s.Save(ctx, f1); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(ctx, f2); err != nil {
		t.Fatal(err)
	}

	got, found, err := s.Get(ctx, "demo.audience")
	if err != nil || !found || got.Percentage != 100 {
		t.Fatalf("после Save флаг читается: %+v found=%v err=%v", got, found, err)
	}

	// List отсортирован по ключу — снимок детерминирован
	list, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].Key != "checkout.new_flow" || list[1].Key != "demo.audience" {
		t.Fatalf("List по ключу: %+v", list)
	}

	// upsert перезаписывает
	f1upd := f1
	f1upd.Percentage = 40
	if err := s.Save(ctx, f1upd); err != nil {
		t.Fatal(err)
	}
	got, _, _ = s.Get(ctx, "demo.audience")
	if got.Percentage != 40 {
		t.Fatalf("upsert должен перезаписать: %+v", got)
	}
}

func TestRevisionsFreshFirstAndSurviveDelete(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	// три правки одного флага
	for i, p := range []int{10, 50, 90} {
		if err := s.Save(ctx, domain.Flag{
			Key: "roll.flag", Enabled: true, Percentage: p, UpdatedBy: "admin",
			UpdatedAt: time.Date(2026, 11, 2, 10, i, 0, 0, time.UTC),
		}); err != nil {
			t.Fatal(err)
		}
	}
	revs, err := s.Revisions(ctx, "roll.flag", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(revs) != 3 || revs[0].Snapshot.Percentage != 90 || revs[2].Snapshot.Percentage != 10 {
		t.Fatalf("аудит свежими сверху: %+v", revs)
	}

	// limit режет хвост
	if revs, _ := s.Revisions(ctx, "roll.flag", 1); len(revs) != 1 || revs[0].Snapshot.Percentage != 90 {
		t.Fatalf("limit=1 — только свежая: %+v", revs)
	}

	// аудит переживает удаление флага
	if deleted, _ := s.Delete(ctx, "roll.flag"); !deleted {
		t.Fatalf("флаг должен удалиться")
	}
	if revs, err := s.Revisions(ctx, "roll.flag", 10); err != nil || len(revs) != 3 {
		t.Fatalf("история правок переживает флаг: %d / %v", len(revs), err)
	}
}

func TestDeleteUnknown(t *testing.T) {
	s := NewStore()
	if deleted, err := s.Delete(context.Background(), "ghost.flag"); err != nil || deleted {
		t.Fatalf("чужого флага нет — false без ошибки: %v / %v", deleted, err)
	}
}

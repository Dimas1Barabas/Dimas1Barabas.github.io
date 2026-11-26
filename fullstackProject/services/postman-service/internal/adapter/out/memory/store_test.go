package memory

import (
	"context"
	"testing"
	"time"

	"postman-service/internal/domain"
)

var epoch = time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)

func sub(id string) domain.Subscription {
	return domain.Subscription{ID: id, URL: "http://p.local/h", Secret: "whsec_" + id, Active: true, CreatedAt: epoch}
}

func dl(id, subID, eventID string, status domain.DeliveryStatus, next time.Time) domain.Delivery {
	return domain.Delivery{
		ID: id, SubscriptionID: subID, EventID: eventID,
		EventType: "booking.processed", Payload: []byte(`{}`),
		Status: status, NextAttemptAt: next, CreatedAt: epoch,
	}
}

func TestSubscriptionsCRUD(t *testing.T) {
	ctx := context.Background()
	store := NewStore()

	if err := store.Subs.Add(ctx, sub("s1")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := store.Subs.Add(ctx, sub("s2")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if got, err := store.Subs.Get(ctx, "s1"); err != nil || got.ID != "s1" {
		t.Fatalf("Get: %v %+v", err, got)
	}
	if _, err := store.Subs.Get(ctx, "netu"); err != domain.ErrSubscriptionNotFound {
		t.Fatalf("чужой id: %v", err)
	}

	list, _ := store.Subs.List(ctx)
	if len(list) != 2 {
		t.Fatalf("List: %d", len(list))
	}

	if ok, _ := store.Subs.Delete(ctx, "s2"); !ok {
		t.Fatal("Delete должен найти")
	}
	if ok, _ := store.Subs.Delete(ctx, "s2"); ok {
		t.Fatal("повторный Delete не должен находить")
	}
}

func TestDeliveriesQueueLifecycle(t *testing.T) {
	ctx := context.Background()
	store := NewStore()
	_ = store.Subs.Add(ctx, sub("s1"))

	// идемпотентность: дубль пары (подписка, событие) не заводится
	_ = store.Deliveries.Enqueue(ctx, []domain.Delivery{
		dl("d1", "s1", "e1", domain.StatusQueued, epoch),
		dl("d1copy", "s1", "e1", domain.StatusQueued, epoch),
		dl("d2", "s1", "e2", domain.StatusQueued, epoch.Add(time.Minute)),
	})
	all, _ := store.Deliveries.List(ctx, domain.DeliveryFilter{})
	if len(all) != 2 {
		t.Fatalf("после дубля должно остаться 2: %d", len(all))
	}

	// Due: настоевшая берётся, будущая нет; старая первой
	due, _ := store.Deliveries.Due(ctx, epoch, 10)
	if len(due) != 1 || due[0].ID != "d1" {
		t.Fatalf("Due: %+v", due)
	}

	// Save: доставка зафиксирована, очередь её больше не видит
	got := due[0]
	got.Status = domain.StatusDelivered
	at := epoch.Add(time.Second)
	got.DeliveredAt = &at
	if err := store.Deliveries.Save(ctx, got); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := store.Deliveries.Save(ctx, dl("netu", "s1", "x", domain.StatusQueued, epoch)); err != domain.ErrDeliveryNotFound {
		t.Fatalf("Save чужой: %v", err)
	}

	// Replay: delivered → queued/0; queued → отказ; чужая → not found
	revived, err := store.Deliveries.Replay(ctx, "d1", epoch)
	if err != nil || revived.Status != domain.StatusQueued || revived.Attempts != 0 {
		t.Fatalf("Replay: %v %+v", err, revived)
	}
	if _, err := store.Deliveries.Replay(ctx, "d1", epoch); err != domain.ErrNotReplayable {
		t.Fatalf("queued replay: %v", err)
	}
	if _, err := store.Deliveries.Replay(ctx, "netu", epoch); err != domain.ErrDeliveryNotFound {
		t.Fatalf("чужой replay: %v", err)
	}
	if _, err := store.Deliveries.Get(ctx, "d2"); err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, err := store.Deliveries.Get(ctx, "netu"); err != domain.ErrDeliveryNotFound {
		t.Fatalf("чужой Get: %v", err)
	}
}

func TestDeliveriesFiltersAndCounts(t *testing.T) {
	ctx := context.Background()
	store := NewStore()
	_ = store.Subs.Add(ctx, sub("s1"))
	_ = store.Subs.Add(ctx, sub("s2"))

	_ = store.Deliveries.Enqueue(ctx, []domain.Delivery{
		dl("d1", "s1", "e1", domain.StatusQueued, epoch),
		dl("d2", "s1", "e2", domain.StatusDead, time.Time{}),
		dl("d3", "s2", "e3", domain.StatusDelivered, epoch),
	})

	bySub, _ := store.Deliveries.List(ctx, domain.DeliveryFilter{SubscriptionID: "s1"})
	if len(bySub) != 2 {
		t.Fatalf("фильтр по подписке: %d", len(bySub))
	}
	byStatus, _ := store.Deliveries.List(ctx, domain.DeliveryFilter{Status: domain.StatusDead})
	if len(byStatus) != 1 || byStatus[0].ID != "d2" {
		t.Fatalf("фильтр по статусу: %+v", byStatus)
	}
	limited, _ := store.Deliveries.List(ctx, domain.DeliveryFilter{Limit: 2})
	if len(limited) != 2 {
		t.Fatalf("лимит: %d", len(limited))
	}

	counts, _ := store.Deliveries.Counts(ctx)
	if counts[domain.StatusQueued] != 1 || counts[domain.StatusDead] != 1 || counts[domain.StatusDelivered] != 1 {
		t.Fatalf("итоги: %+v", counts)
	}
}

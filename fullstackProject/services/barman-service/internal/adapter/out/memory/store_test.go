package memory

import (
	"context"
	"testing"
	"time"

	"barman-service/internal/domain"
)

func order(id string, status domain.Status, createdAt time.Time) domain.Order {
	return domain.Order{OrderID: id, CustomerName: "Гость " + id, Status: status, CreatedAt: createdAt}
}

// Доска раскладывает заказы по колонкам: активные — по времени приёма,
// закрытые — свежие сверху, лента ограничена.
func TestBoardColumns(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	base := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

	_ = s.Upsert(ctx, order("a", domain.StatusNew, base.Add(2*time.Minute)))
	_ = s.Upsert(ctx, order("b", domain.StatusNew, base))
	_ = s.Upsert(ctx, order("c", domain.StatusPreparing, base.Add(time.Minute)))
	_ = s.Upsert(ctx, order("d", domain.StatusReady, base))
	// закрытые: старый выдан раньше свежей отмены
	picked := order("e", domain.StatusPickedUp, base)
	picked.ChangedAt = base.Add(10 * time.Minute)
	_ = s.Upsert(ctx, picked)
	_ = s.Save(ctx, picked)
	cancelled := order("f", domain.StatusCancelled, base)
	cancelled.ChangedAt = base.Add(20 * time.Minute)
	_ = s.Upsert(ctx, cancelled)
	_ = s.Save(ctx, cancelled)

	board, err := s.Board(ctx)
	if err != nil {
		t.Fatalf("Board: %v", err)
	}
	if ids := ids(board.New); len(ids) != 2 || ids[0] != "b" || ids[1] != "a" {
		t.Fatalf("NEW не по времени приёма: %v", ids)
	}
	if ids := ids(board.Preparing); len(ids) != 1 || ids[0] != "c" {
		t.Fatalf("PREPARING: %v", ids)
	}
	if ids := ids(board.Ready); len(ids) != 1 || ids[0] != "d" {
		t.Fatalf("READY: %v", ids)
	}
	if ids := ids(board.Recent); len(ids) != 2 || ids[0] != "f" || ids[1] != "e" {
		t.Fatalf("Recent не свежие сверху: %v", ids)
	}
}

func TestUpsertIdempotentGetSave(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	if err := s.Upsert(ctx, order("a", domain.StatusNew, time.Now())); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	o, _ := s.Get(ctx, "a")
	o.Status = domain.StatusPreparing
	if err := s.Save(ctx, o); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// ределивери created не сбрасывает прогресс
	_ = s.Upsert(ctx, order("a", domain.StatusNew, time.Now()))
	o, _ = s.Get(ctx, "a")
	if o.Status != domain.StatusPreparing {
		t.Fatalf("ределивери сбросил прогресс: %s", o.Status)
	}

	if _, err := s.Get(ctx, "нет-такого"); err != domain.ErrOrderNotFound {
		t.Fatalf("Get неизвестного: %v, ожидался ErrOrderNotFound", err)
	}
}

func ids(orders []domain.Order) []string {
	out := make([]string, 0, len(orders))
	for _, o := range orders {
		out = append(out, o.OrderID)
	}
	return out
}

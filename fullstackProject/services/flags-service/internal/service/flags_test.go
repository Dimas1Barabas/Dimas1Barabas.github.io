package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"flags-service/internal/domain"
)

// fakeStore — стаб порта: карта флагов с подменяемой ошибкой.
type fakeStore struct {
	flags     map[string]domain.Flag
	revisions []domain.Revision
	err       error
}

func (f *fakeStore) Get(_ context.Context, key string) (domain.Flag, bool, error) {
	if f.err != nil {
		return domain.Flag{}, false, f.err
	}
	g, ok := f.flags[key]
	return g, ok, nil
}

func (f *fakeStore) List(_ context.Context) ([]domain.Flag, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([]domain.Flag, 0, len(f.flags))
	for _, g := range f.flags {
		out = append(out, g)
	}
	return out, nil
}

func (f *fakeStore) Save(_ context.Context, g domain.Flag) error {
	if f.err != nil {
		return f.err
	}
	f.flags[g.Key] = g
	f.revisions = append(f.revisions, domain.Revision{Key: g.Key, ChangedBy: g.UpdatedBy, ChangedAt: g.UpdatedAt, Snapshot: g})
	return nil
}

func (f *fakeStore) Delete(_ context.Context, key string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	if _, ok := f.flags[key]; !ok {
		return false, nil
	}
	delete(f.flags, key)
	return true, nil
}

func (f *fakeStore) Revisions(_ context.Context, key string, limit int) ([]domain.Revision, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := make([]domain.Revision, 0)
	for i := len(f.revisions) - 1; i >= 0 && len(out) < limit; i-- {
		if f.revisions[i].Key == key {
			out = append(out, f.revisions[i])
		}
	}
	return out, nil
}

func newTestService() (*Flags, *fakeStore) {
	store := &fakeStore{flags: map[string]domain.Flag{}}
	svc := New(store)
	return svc, store
}

func TestEvaluateNotFoundIsOffNotError(t *testing.T) {
	svc, _ := newTestService()
	v, err := svc.Evaluate(context.Background(), "no.such_flag", "user-1")
	if err != nil {
		t.Fatalf("отсутствие флага — не ошибка: %v", err)
	}
	if v.Enabled || v.Reason != domain.ReasonNotFound {
		t.Fatalf("нет флага — оф с not_found: %+v", v)
	}
}

func TestEvaluateUsesDomainRules(t *testing.T) {
	svc, _ := newTestService()
	ctx := context.Background()
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "checkout.new_flow", Description: "новый чекаут", Enabled: true, Percentage: 15, UpdatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	// user-2 — бакет 10, внутри 15%
	v, err := svc.Evaluate(ctx, "checkout.new_flow", "user-2")
	if err != nil || !v.Enabled || v.Reason != domain.ReasonPercentage {
		t.Fatalf("user-2 внутри раскатки: %+v / %v", v, err)
	}
	// user-1 — бакет 99, снаружи
	v, err = svc.Evaluate(ctx, "checkout.new_flow", "user-1")
	if err != nil || v.Enabled {
		t.Fatalf("user-1 снаружи раскатки: %+v / %v", v, err)
	}
}

func TestUpsertValidation(t *testing.T) {
	svc, _ := newTestService()
	ctx := context.Background()

	if _, err := svc.Upsert(ctx, domain.Flag{Key: "Плохой Ключ", Percentage: 50}); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("ожидали ErrInvalidKey, получили %v", err)
	}
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "ok.flag", Percentage: 101}); !errors.Is(err, ErrInvalidPercent) {
		t.Fatalf("ожидали ErrInvalidPercent, получили %v", err)
	}
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "ok.flag", Percentage: -1}); !errors.Is(err, ErrInvalidPercent) {
		t.Fatalf("отрицательный процент — ErrInvalidPercent: %v", err)
	}
}

func TestUpsertStampsServiceTime(t *testing.T) {
	svc, store := newTestService()
	fixed := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fixed }

	f, err := svc.Upsert(context.Background(), domain.Flag{Key: "ok.flag", Percentage: 50, UpdatedBy: "qa"})
	if err != nil {
		t.Fatal(err)
	}
	if !f.UpdatedAt.Equal(fixed) {
		t.Fatalf("штамп времени ставит сервис: %+v", f.UpdatedAt)
	}
	if store.flags["ok.flag"].UpdatedAt != fixed {
		t.Fatalf("в хранилище должен уйти штамп сервиса")
	}
}

func TestDeleteAndRevisions(t *testing.T) {
	svc, _ := newTestService()
	ctx := context.Background()

	if _, err := svc.Upsert(ctx, domain.Flag{Key: "tmp.flag", Enabled: true, Percentage: 5, UpdatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	deleted, err := svc.Delete(ctx, "tmp.flag")
	if err != nil || !deleted {
		t.Fatalf("удаление существующего: %v / %v", deleted, err)
	}
	if deleted, err := svc.Delete(ctx, "tmp.flag"); err != nil || deleted {
		t.Fatalf("повторное удаление — false: %v / %v", deleted, err)
	}
	// аудит пережил флаг
	revs, err := svc.Revisions(ctx, "tmp.flag", 10)
	if err != nil || len(revs) != 1 {
		t.Fatalf("аудит правки должен пережить флаг: %d / %v", len(revs), err)
	}
}

func TestStoreErrorPropagates(t *testing.T) {
	boom := errors.New("хранилище мертво")
	svc := New(&fakeStore{err: boom, flags: map[string]domain.Flag{}})
	ctx := context.Background()
	if _, err := svc.Evaluate(ctx, "any.flag", "u"); !errors.Is(err, boom) {
		t.Fatalf("ошибка хранилища должна всплыть вызывающему: %v", err)
	}
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "ok.flag", Percentage: 1}); !errors.Is(err, boom) {
		t.Fatalf("и на правках тоже: %v", err)
	}
}

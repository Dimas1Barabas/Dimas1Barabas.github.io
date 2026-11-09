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

// fakeStats — стаб порта метрик: запоминает отчёты списком.
type fakeStats struct {
	rows []domain.VariantStat
}

func (f *fakeStats) Add(_ context.Context, key, variant string, conversion bool) error {
	for i := range f.rows {
		if f.rows[i].Key == key && f.rows[i].Variant == variant {
			if conversion {
				f.rows[i].Conversions++
			} else {
				f.rows[i].Exposures++
			}
			return nil
		}
	}
	row := domain.VariantStat{Key: key, Variant: variant}
	if conversion {
		row.Conversions = 1
	} else {
		row.Exposures = 1
	}
	f.rows = append(f.rows, row)
	return nil
}

func (f *fakeStats) Stats(_ context.Context) ([]domain.VariantStat, error) {
	return f.rows, nil
}

func newTestService() (*Flags, *fakeStore, *fakeStats) {
	store := &fakeStore{flags: map[string]domain.Flag{}}
	stats := &fakeStats{}
	svc := New(store, stats)
	return svc, store, stats
}

func TestEvaluateNotFoundIsOffNotError(t *testing.T) {
	svc, _, _ := newTestService()
	v, err := svc.Evaluate(context.Background(), "no.such_flag", "user-1")
	if err != nil {
		t.Fatalf("отсутствие флага — не ошибка: %v", err)
	}
	if v.Enabled || v.Reason != domain.ReasonNotFound {
		t.Fatalf("нет флага — оф с not_found: %+v", v)
	}
}

func TestEvaluateUsesDomainRules(t *testing.T) {
	svc, _, _ := newTestService()
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
	svc, _, _ := newTestService()
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
	svc, store, _ := newTestService()
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
	svc, _, _ := newTestService()
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
	svc := New(&fakeStore{err: boom, flags: map[string]domain.Flag{}}, &fakeStats{})
	ctx := context.Background()
	if _, err := svc.Evaluate(ctx, "any.flag", "u"); !errors.Is(err, boom) {
		t.Fatalf("ошибка хранилища должна всплыть вызывающему: %v", err)
	}
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "ok.flag", Percentage: 1}); !errors.Is(err, boom) {
		t.Fatalf("и на правках тоже: %v", err)
	}
	// отчёты метрик тоже честны со сбоем хранилища флагов
	if _, counted, err := svc.ReportExposure(ctx, "any.flag", "u"); err == nil || counted {
		t.Fatalf("отчёт при мёртвом хранилище — ошибка, не молчание: %v", err)
	}
}

func TestUpsertVariants(t *testing.T) {
	svc, _, _ := newTestService()
	ctx := context.Background()

	// валидный эксперимент сохраняется целиком
	exp := domain.Flag{
		Key:     "booking.qr_v2",
		Enabled: true,
		Variants: []domain.Variant{
			{Name: "a", Percentage: 10},
			{Name: "b", Percentage: 30},
		},
		UpdatedBy: "admin",
	}
	saved, err := svc.Upsert(ctx, exp)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Variants) != 2 || saved.Variants[0].Name != "a" {
		t.Fatalf("варианты должны вернуться сохранёнными: %+v", saved.Variants)
	}

	// невалидные варианты — отдельная ошибка конфигурации
	bad := exp
	bad.Variants = []domain.Variant{
		{Name: "a", Percentage: 60},
		{Name: "b", Percentage: 60},
	}
	if _, err := svc.Upsert(ctx, bad); !errors.Is(err, ErrInvalidVariants) {
		t.Fatalf("сумма долей 120 — ErrInvalidVariants: %v", err)
	}
}

func TestReportExperiment(t *testing.T) {
	svc, _, stats := newTestService()
	ctx := context.Background()

	// not_found — не ошибка и НЕ считается: реестра «известных флагов» нет
	if variant, counted, err := svc.ReportExposure(ctx, "no.such", "user-1"); err != nil || counted || variant != "" {
		t.Fatalf("отчёт о несуществующем флаге — counted=false: %q %v %v", variant, counted, err)
	}
	if len(stats.rows) != 0 {
		t.Fatalf("счётчики не должны тронуться: %+v", stats.rows)
	}

	// эксперимент: вариант пересчитывает сервис по бакетингу
	// (бакеты векторов: user-1 → 99, user-2 → 10, user-3 → 21)
	if _, err := svc.Upsert(ctx, domain.Flag{
		Key:     "checkout.new_flow",
		Enabled: true,
		Variants: []domain.Variant{
			{Name: "a", Percentage: 15},
			{Name: "b", Percentage: 20},
		},
		UpdatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	// user-2 (бакет 10) — вариант a; user-1 (99) — база
	if variant, counted, _ := svc.ReportExposure(ctx, "checkout.new_flow", "user-2"); !counted || variant != "a" {
		t.Fatalf("экспозиция user-2 — вариант a: %q %v", variant, counted)
	}
	if variant, counted, _ := svc.ReportConversion(ctx, "checkout.new_flow", "user-2"); !counted || variant != "a" {
		t.Fatalf("конверсия user-2 — тот же вариант a: %q %v", variant, counted)
	}
	if variant, _, _ := svc.ReportExposure(ctx, "checkout.new_flow", "user-1"); variant != "" {
		t.Fatalf("экспозиция user-1 — база (пустой вариант): %q", variant)
	}

	// витрина метрик: строка на вариант, конверсия рядом с экспозицией
	rows, err := svc.ExperimentStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byVariant := map[string]domain.VariantStat{}
	for _, r := range rows {
		byVariant[r.Variant] = r
	}
	if byVariant["a"].Exposures != 1 || byVariant["a"].Conversions != 1 {
		t.Fatalf("вариант a: 1 экспозиция и 1 конверсия: %+v", byVariant["a"])
	}
	if byVariant[""].Exposures != 1 || byVariant[""].Conversions != 0 {
		t.Fatalf("база: 1 экспозиция без конверсий: %+v", byVariant[""])
	}
}

func TestReportPlainFlagImplicitVariants(t *testing.T) {
	svc, _, _ := newTestService()
	ctx := context.Background()

	// обычный флаг (без вариантов): метрики считают те же отчёты,
	// implicit-варианты on/off — механика единая для всех тумблеров
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "checkout.new_flow", Enabled: true, Percentage: 15, UpdatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}
	// user-2 (бакет 10) — внутри 15% → on; user-1 (99) — снаружи → off
	if variant, _, _ := svc.ReportExposure(ctx, "checkout.new_flow", "user-2"); variant != "on" {
		t.Fatalf("внутри раскатки — вариант on: %q", variant)
	}
	if variant, _, _ := svc.ReportExposure(ctx, "checkout.new_flow", "user-1"); variant != "off" {
		t.Fatalf("снаружи раскатки — вариант off: %q", variant)
	}
	if rows, _ := svc.ExperimentStats(ctx); len(rows) != 2 {
		t.Fatalf("on и off — две строки метрик: %+v", rows)
	}
}

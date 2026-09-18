package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"notification-service/internal/domain"
)

// Живые тесты против локального стенда (postgres из docker-compose).
// Базы нет, PG не поднят (локальный прогон без Docker, CI) — честный
// skip, как у e2e API; тестовая база пересоздаётся каждым прогоном.

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_notifications_test"
}

// requirePostgres — graceful-skip: коннект к служебной базе за 3 с
// не прошёл, значит стенда нет — пропускаем, а не красним CI.
func requirePostgres(t *testing.T, dsn string) {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("парсинг DSN %q: %v", dsn, err)
	}
	adm := adminConfig(cfg)
	adm.ConnectTimeout = 3 * time.Second

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, adm)
	if err != nil {
		t.Skipf("Postgres недоступен (%v) — live-тесты пропущены; docker compose up -d postgres", err)
	}
	_ = conn.Close(context.Background())
}

// dropDatabase убивает тестовую базу (WITH FORCE отцепляет сессии),
// чтобы каждый прогон начинался с чистого листа и не оставлял хвоста.
func dropDatabase(t *testing.T, dsn string) {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("парсинг DSN %q: %v", dsn, err)
	}
	adm := adminConfig(cfg)
	adm.ConnectTimeout = 3 * time.Second

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, adm)
	if err != nil {
		t.Fatalf("коннект к служебной базе для DROP: %v", err)
	}
	defer conn.Close(context.Background())

	quoted := `"` + strings.ReplaceAll(cfg.Database, `"`, `""`) + `"`
	if _, err := conn.Exec(ctx, "DROP DATABASE IF EXISTS "+quoted+" WITH (FORCE)"); err != nil {
		t.Fatalf("drop тестовой базы %s: %v", cfg.Database, err)
	}
}

// withRepo поднимает адаптер на чистой тестовой базе: сначала дропаем
// хвост прошлых прогонов, затем NewRepository сам проходит весь путь
// «создать базу → пинг → схема».
func withRepo(t *testing.T) *Repository {
	t.Helper()
	dsn := testDSN()
	requirePostgres(t, dsn)
	dropDatabase(t, dsn)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	repo, err := NewRepository(ctx, dsn)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() {
		_ = repo.Close()
		dropDatabase(t, dsn)
	})
	return repo
}

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

func TestSaveListRoundtrip(t *testing.T) {
	r := withRepo(t)
	base := time.Date(2026, 9, 18, 9, 0, 0, 0, time.UTC)

	n, err := domain.NewFromOutcome(
		domain.Outcome{BookingID: "b-1", Verdict: "CONFIRMED", Message: "сеанс подтверждён"}, base)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Save(context.Background(), n); err != nil {
		t.Fatal(err)
	}

	items, err := r.List(context.Background(), domain.Filter{BookingID: "b-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("прочитано %d записей, want 1", len(items))
	}
	got := items[0]
	// timestamptz хранит мгновение: сравниваем только через Equal
	// (зона сессии может отдать другой offset, нс обрезаны до мкс)
	if got.ID != n.ID || got.BookingID != n.BookingID || got.Kind != n.Kind ||
		got.Title != n.Title || got.Body != n.Body || got.Channel != n.Channel ||
		got.Status != n.Status {
		t.Fatalf("roundtrip: %+v, want %+v", got, n)
	}
	if !got.CreatedAt.UTC().Equal(n.CreatedAt) {
		t.Fatalf("CreatedAt = %v, want %v", got.CreatedAt, n.CreatedAt)
	}
}

func TestListNewestFirst(t *testing.T) {
	r := withRepo(t)
	base := time.Date(2026, 9, 18, 9, 0, 0, 0, time.UTC)

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

func TestFilterAndLimit(t *testing.T) {
	r := withRepo(t)
	base := time.Date(2026, 9, 18, 9, 0, 0, 0, time.UTC)

	for i, booking := range []string{"b-1", "b-1", "b-2"} {
		saveAt(t, r, booking, "CONFIRMED", base.Add(time.Duration(i)*time.Second))
	}

	byBooking, err := r.List(context.Background(), domain.Filter{BookingID: "b-1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(byBooking) != 2 {
		t.Fatalf("по брони b-1 = %d записей, want 2", len(byBooking))
	}

	limited, err := r.List(context.Background(), domain.Filter{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 2 || limited[0].BookingID != "b-2" {
		t.Fatalf("лимит 2: %v", limited)
	}
}

func TestListEmptyIsNotNullSlice(t *testing.T) {
	r := withRepo(t)

	items, err := r.List(context.Background(), domain.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if items == nil {
		t.Fatal("пустая история = nil, want пустой слайс (JSON «[]», не «null»)")
	}
	if len(items) != 0 {
		t.Fatalf("пустая история = %d записей, want 0", len(items))
	}
}

func TestSaveFailedStatusKeepsError(t *testing.T) {
	r := withRepo(t)
	base := time.Date(2026, 9, 18, 9, 0, 0, 0, time.UTC)

	n, err := domain.NewFromOutcome(domain.Outcome{BookingID: "b-3", Verdict: "REFUND_FAILED"}, base)
	if err != nil {
		t.Fatal(err)
	}
	n.Status, n.Error = domain.StatusFailed, "SMTP gateway timeout"
	if err := r.Save(context.Background(), n); err != nil {
		t.Fatal(err)
	}

	items, err := r.List(context.Background(), domain.Filter{BookingID: "b-3"})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Status != domain.StatusFailed || items[0].Error != n.Error {
		t.Fatalf("неудачная доставка: %+v, want status FAILED и текст ошибки", items)
	}
}

func TestNewRepositoryIdempotent(t *testing.T) {
	dsn := testDSN()
	requirePostgres(t, dsn)
	dropDatabase(t, dsn)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	first, err := NewRepository(ctx, dsn)
	if err != nil {
		t.Fatalf("первый NewRepository: %v", err)
	}
	defer first.Close()

	// второй старт на существующей базе: ветка «база уже есть» + IF NOT EXISTS
	second, err := NewRepository(ctx, dsn)
	if err != nil {
		t.Fatalf("повторный NewRepository: %v", err)
	}
	second.Close()

	t.Cleanup(func() {
		_ = first.Close()
		dropDatabase(t, dsn)
	})
}

// TestStatements — юнит без БД (гоняется и в CI): embedded DDL режется
// на непустые стейтменты без потерянных хвостов.
func TestStatements(t *testing.T) {
	sts := statements(schemaSQL)
	if len(sts) < 2 {
		t.Fatalf("statements = %d, want >= 2", len(sts))
	}
	for _, st := range sts {
		if !strings.Contains(strings.ToUpper(st), "CREATE") {
			t.Fatalf("стейтмент без CREATE: %q", st)
		}
	}
}

package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"pricing-service/internal/domain"
)

// Живые тесты против локального стенда (postgres из docker-compose).
// Базы нет, PG не поднят (локальный прогон без Docker, CI) — честный
// skip, как у e2e API; тестовая база пересоздаётся каждым прогоном.

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_prices_test"
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
		t.Fatalf("парсинг DSN: %v", err)
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
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func TestDemandLifecycle(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	if _, err := repo.ApplyHeld(ctx, "s-1", "b-1", 3); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ApplyHeld(ctx, "s-1", "b-2", 2); err != nil {
		t.Fatal(err)
	}
	if got, err := repo.Demand(ctx, "s-1"); err != nil || got != 5 {
		t.Fatalf("demand = %d (%v), want 5", got, err)
	}

	// redelivery — дубль по (booking, kind), спрос не двинулся
	applied, err := repo.ApplyHeld(ctx, "s-1", "b-1", 3)
	if err != nil {
		t.Fatal(err)
	}
	if applied {
		t.Fatal("дубль held должен быть no-op")
	}
	if got, _ := repo.Demand(ctx, "s-1"); got != 5 {
		t.Fatalf("demand = %d, want 5", got)
	}

	// частичное освобождение: b-1 вернула 3 места
	if _, err := repo.ApplyReleased(ctx, "s-1", "b-1", 3); err != nil {
		t.Fatal(err)
	}
	if got, _ := repo.Demand(ctx, "s-1"); got != 2 {
		t.Fatalf("demand = %d, want 2", got)
	}

	// аномальное освобождение больше остатка — clamp в ноль
	if _, err := repo.ApplyReleased(ctx, "s-1", "b-x", 9); err != nil {
		t.Fatal(err)
	}
	if got, _ := repo.Demand(ctx, "s-1"); got != 0 {
		t.Fatalf("demand = %d, want 0", got)
	}
}

func TestUnknownSessionDemandZero(t *testing.T) {
	repo := withRepo(t)
	got, err := repo.Demand(context.Background(), "нет-такого")
	if err != nil {
		t.Fatal(err)
	}
	if got != 0 {
		t.Fatalf("demand = %d, want 0", got)
	}
}

func TestQuotesShowcase(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	q, err := domain.ComputeQuote(time.Date(2026, time.September, 22, 19, 0, 0, 0, time.Local), 400, 70, 80)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.LogQuote(ctx, "s-1", q); err != nil {
		t.Fatal(err)
	}
	quotes, err := repo.ListQuotes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(quotes) != 1 {
		t.Fatalf("витрина квотов = %+v, want 1 запись", quotes)
	}
	if quotes[0].SessionID != "s-1" || quotes[0].PriceRub != q.PriceRub || quotes[0].Factors == "" {
		t.Fatalf("запись квота = %+v", quotes[0])
	}

	rows, err := repo.ListDemand(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("витрина спроса без событий должна быть пуста: %+v", rows)
	}
}

func TestStatementsSplit(t *testing.T) {
	// DDL режется по «;» с выкидыванием строк-комментариев: сегменты
	// непустые, стейтментов схемы ровно пять (2 таблицы журнала/квотов,
	// таблица спроса и два индекса)
	got := statements(schemaSQL)
	if len(got) != 5 {
		t.Fatalf("сегментов схемы = %d (%v), want 5", len(got), got)
	}
	for _, st := range got {
		if strings.Contains(st, "--") && strings.HasPrefix(strings.TrimSpace(st), "--") {
			t.Fatalf("комментарий попал в исполняемый сегмент: %q", st)
		}
	}
}

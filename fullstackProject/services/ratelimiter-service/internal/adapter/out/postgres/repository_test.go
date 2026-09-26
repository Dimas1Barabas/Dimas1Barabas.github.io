package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"ratelimiter-service/internal/domain"
)

// Живые тесты против локального стенда (postgres из docker-compose).
// Базы нет, PG не поднят (локальный прогон без Docker, CI) — честный
// skip, как у e2e API; тестовая база пересоздаётся каждым прогоном.

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_ratekeeper_test"
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

// withRepo: skip без PG → чистая база → репозиторий (сам создаст базу
// и схему) → Close по завершении теста.
func withRepo(t *testing.T) *Repository {
	t.Helper()
	dsn := testDSN()
	requirePostgres(t, dsn)
	dropDatabase(t, dsn)
	repo, err := NewRepository(context.Background(), dsn)
	if err != nil {
		t.Fatalf("репозиторий: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func TestBucketLifecycle(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()
	p := domain.PolicyOf(10)

	for i := 0; i < 10; i++ {
		taken, _, err := repo.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
		if err != nil || !taken {
			t.Fatalf("бронь %d: taken=%v err=%v", i+1, taken, err)
		}
	}
	taken, remaining, err := repo.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
	if err != nil {
		t.Fatalf("не ждали ошибку: %v", err)
	}
	if taken || remaining >= 1 {
		t.Fatalf("11-я подряд должна отказать: taken=%v remaining=%v", taken, remaining)
	}

	rows, err := repo.ListBuckets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Taken {
		t.Fatalf("витрина должна показать отказ: %+v", rows)
	}

	// у другого клиента — своя корзина
	taken2, _, err := repo.Take(ctx, domain.ActionBookingsCreate, "u-2", p)
	if err != nil || !taken2 {
		t.Fatalf("чужая корзина не должна пострадать: taken=%v err=%v", taken2, err)
	}
}

func TestRefillAfterPause(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()
	p := domain.PolicyOf(10)

	// первый визит создаёт корзину
	if taken, _, _ := repo.Take(ctx, domain.ActionAuthLogin, "bot@test.local", p); !taken {
		t.Fatalf("первый визит — полный бак")
	}
	// имитируем паузу: откатываем время последней проверки на 2 минуты
	if _, err := repo.db.ExecContext(ctx,
		`UPDATE buckets SET tokens = 0, updated_at = now() - interval '2 minutes'
		 WHERE action = $1 AND client_key = $2`,
		string(domain.ActionAuthLogin), "bot@test.local",
	); err != nil {
		t.Fatalf("подготовка паузы: %v", err)
	}
	// долив за 2 мин = 20 токенов, кламп в ёмкость 10 → списание проходит
	taken, _, err := repo.Take(ctx, domain.ActionAuthLogin, "bot@test.local", p)
	if err != nil || !taken {
		t.Fatalf("после паузы корзина полная: taken=%v err=%v", taken, err)
	}
}

func TestConcurrentTake(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()
	p := domain.PolicyOf(10)

	// 50 одновременных проверок одной корзины: снять должны ровно
	// ёмкость (допустим +1 на гонку «первых визитов»)
	results := make(chan bool, 50)
	for i := 0; i < 50; i++ {
		go func() {
			taken, _, _ := repo.Take(ctx, domain.ActionBookingsCreate, "u-race", p)
			results <- taken
		}()
	}
	allowed := 0
	for i := 0; i < 50; i++ {
		if <-results {
			allowed++
		}
	}
	if allowed < 10 || allowed > 11 {
		t.Fatalf("снято %d токенов, ожидали 10–11", allowed)
	}
}

func TestStatementsSplit(t *testing.T) {
	got := statements(schemaSQL)
	if len(got) != 3 {
		t.Fatalf("сегментов схемы = %d, ожидали 3: %q", len(got), got)
	}
}

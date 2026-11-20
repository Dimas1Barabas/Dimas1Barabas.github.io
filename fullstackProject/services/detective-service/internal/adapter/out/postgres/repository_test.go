package postgres

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"detective-service/internal/domain"
)

// Живые тесты против Postgres двумя путями: локально — стенд
// (postgres из docker-compose, порт 15432) или TEST_DATABASE_URL,
// в CI (TESTCONTAINERS=1) — одноразовый контейнер testcontainers.
// Нет ни того, ни другого — честный skip, как у e2e API; тестовая
// база пересоздаётся каждым тестом.

var t40 = domain.Thresholds{Review: 40, Block: 70}

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_detective_test"
}

// TestMain: TESTCONTAINERS=1 (CI) — поднимаем одноразовый Postgres
// на пакет и подменяем TEST_DATABASE_URL его DSN, поэтому остальной
// код тестов (requirePostgres/dropDatabase/withRepo) не меняется.
// Локально переменную не ставим — прежние стенд или skip; живой
// прогон в CI делает робот, машина разработчика контейнеры не трогает.
func TestMain(m *testing.M) {
	os.Exit(run(m))
}

func run(m *testing.M) (code int) {
	if os.Getenv("TESTCONTAINERS") != "1" {
		return m.Run()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	cnt, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("cine_detective_test"),
		// без wait-стратегии Run возвращает «running», а не «ready»:
		// postgres ещё делает initdb, коннект ловит RST и тест скипается
		tcpostgres.BasicWaitStrategies(),
	)
	if err != nil {
		log.Fatalf("testcontainers postgres: %v", err)
	}
	defer func() { _ = cnt.Terminate(ctx) }()

	dsn, err := cnt.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		log.Fatalf("DSN контейнера: %v", err)
	}
	if err := os.Setenv("TEST_DATABASE_URL", dsn); err != nil {
		log.Fatalf("TEST_DATABASE_URL: %v", err)
	}
	return m.Run()
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
	defer func() { _ = conn.Close(context.Background()) }()

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

func TestDecisionLifecycle(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	// спокойная бронь — авто-allow, в очередь не попадает
	calm, err := repo.Save(ctx, domain.Score(domain.Facts{
		BookingID: "b-calm", UserID: "u-1", SeatsCount: 2, TotalRub: 800, AccountAgeDays: 30,
	}, t40))
	if err != nil {
		t.Fatal(err)
	}
	if calm.Status != domain.StatusAutoAllowed {
		t.Fatalf("статус = %s, хочу auto_allowed", calm.Status)
	}

	// скоринг review-фактов — очередь ревью + коды причин на месте
	fast, err := repo.Save(ctx, domain.Score(domain.Facts{
		BookingID: "b-fast", UserID: "u-2", SeatsCount: 2, TotalRub: 800,
		AccountAgeDays: 0, Bookings24h: 5,
	}, t40))
	if err != nil {
		t.Fatal(err)
	}
	if fast.Status != domain.StatusPendingReview || fast.Score != 55 {
		t.Fatalf("review-решение: %+v", fast)
	}
	if strings.Join(fast.Reasons, ",") != "newAccount,velocity" {
		t.Fatalf("причины: %v", fast.Reasons)
	}

	// повторный Score той же брони — первый вердикт, не пересмотр
	changed, err := repo.Save(ctx, domain.Score(domain.Facts{
		BookingID: "b-fast", UserID: "u-2", SeatsCount: 6, TotalRub: 20000,
		AccountAgeDays: 0, Bookings24h: 20,
	}, t40))
	if err != nil {
		t.Fatal(err)
	}
	if changed.Score != fast.Score || changed.Status != fast.Status {
		t.Fatalf("идемпотентность Save: %+v vs %+v", changed, fast)
	}

	// витрина: свежие сверху, фильтр очереди
	all, err := repo.List(ctx, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].Facts.BookingID != "b-fast" {
		t.Fatalf("витрина: %+v", all)
	}
	pending, err := repo.List(ctx, domain.StatusPendingReview, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].Facts.BookingID != "b-fast" {
		t.Fatalf("очередь ревью: %+v", pending)
	}

	// резолв админом; повтор — AlreadyResolved
	resolved, err := repo.Resolve(ctx, "b-fast", domain.ResolveApprove, "admin@test.local")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Status != domain.StatusApproved || resolved.ResolvedBy != "admin@test.local" || resolved.ResolvedAt.IsZero() {
		t.Fatalf("резолв: %+v", resolved)
	}
	if _, err := repo.Resolve(ctx, "b-fast", domain.ResolveReject, "admin2@test.local"); !errors.Is(err, domain.ErrAlreadyResolved) {
		t.Fatalf("повторный резолв: err = %v, хочу AlreadyResolved", err)
	}
	if _, err := repo.Resolve(ctx, "нет-такой", domain.ResolveApprove, "admin@test.local"); !errors.Is(err, domain.ErrDecisionNotFound) {
		t.Fatalf("чужой booking_id: err = %v, хочу NotFound", err)
	}

	// Get возвращает то же решение
	got, err := repo.Get(ctx, "b-fast")
	if err != nil || got.Status != domain.StatusApproved {
		t.Fatalf("get: rec=%+v err=%v", got, err)
	}
	if _, err := repo.Get(ctx, "нет-такой"); !errors.Is(err, domain.ErrDecisionNotFound) {
		t.Fatalf("get чужого: err = %v, хочу NotFound", err)
	}
}

// параллельные Save одной брони — ровно одно решение, никто не падает
func TestConcurrentSave(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	const n = 20
	facts := domain.Facts{BookingID: "b-race", UserID: "u-9", SeatsCount: 1, TotalRub: 400}
	type result struct {
		rec domain.DecisionRecord
		err error
	}
	results := make(chan result, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec, err := repo.Save(ctx, domain.Score(facts, t40))
			results <- result{rec, err}
		}()
	}
	wg.Wait()
	close(results)

	seen := make(map[int]int)
	for r := range results {
		if r.err != nil {
			t.Fatalf("параллельный Save: %v", r.err)
		}
		seen[r.rec.Score]++
	}
	if len(seen) != 1 {
		t.Fatalf("вердикты разошлись: %v", seen)
	}
	rows, err := repo.List(ctx, "", 0)
	if err != nil || len(rows) != 1 {
		t.Fatalf("должна остаться одна строка: rows=%d err=%v", len(rows), err)
	}
}

func TestStatementsSplit(t *testing.T) {
	got := statements(schemaSQL)
	if len(got) != 3 {
		t.Fatalf("сегментов схемы = %d, ожидали 3: %q", len(got), got)
	}
}

package postgres

import (
	"context"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"flags-service/internal/domain"
)

// Живые тесты против Postgres двумя путями: локально — стенд
// (postgres из docker-compose, порт 15432) или TEST_DATABASE_URL,
// в CI (TESTCONTAINERS=1) — одноразовый контейнер testcontainers.
// Нет ни того, ни другого — честный skip, как у e2e API; тестовая
// база пересоздаётся каждым тестом.

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_flags_test"
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
		tcpostgres.WithDatabase("cine_flags_test"),
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

func TestFlagLifecycle(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	f := domain.Flag{
		Key: "checkout.new_flow", Description: "новый чекаут",
		Enabled: true, Percentage: 15, UpdatedBy: "qa",
		UpdatedAt: time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC),
	}
	if err := repo.Save(ctx, f); err != nil {
		t.Fatal(err)
	}
	got, found, err := repo.Get(ctx, "checkout.new_flow")
	if err != nil || !found {
		t.Fatalf("после Save флаг читается: %v / %v", found, err)
	}
	if got.Percentage != 15 || !got.Enabled || got.UpdatedBy != "qa" || got.Killed {
		t.Fatalf("снимок не совпал: %+v", got)
	}

	// upsert: kill-switch поверх раскатки
	f.Killed, f.Percentage, f.UpdatedBy = true, 100, "admin"
	if err := repo.Save(ctx, f); err != nil {
		t.Fatal(err)
	}
	got, _, _ = repo.Get(ctx, "checkout.new_flow")
	if !got.Killed || got.Percentage != 100 {
		t.Fatalf("upsert должен перезаписать: %+v", got)
	}

	// List по ключу
	list, err := repo.List(ctx)
	if err != nil || len(list) != 1 || list[0].Key != "checkout.new_flow" {
		t.Fatalf("List: %d / %v", len(list), err)
	}

	deleted, err := repo.Delete(ctx, "checkout.new_flow")
	if err != nil || !deleted {
		t.Fatalf("удаление существующего: %v / %v", deleted, err)
	}
	if _, found, _ := repo.Get(ctx, "checkout.new_flow"); found {
		t.Fatalf("после Delete флага нет")
	}
	if deleted, _ := repo.Delete(ctx, "checkout.new_flow"); deleted {
		t.Fatalf("повторное удаление — false")
	}
}

func TestRevisionsSurviveDelete(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	base := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	for i, p := range []int{10, 50, 90} {
		if err := repo.Save(ctx, domain.Flag{
			Key: "roll.flag", Enabled: true, Percentage: p, UpdatedBy: "admin",
			UpdatedAt: base.Add(time.Duration(i) * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}

	revs, err := repo.Revisions(ctx, "roll.flag", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(revs) != 3 {
		t.Fatalf("три правки в аудите: %d", len(revs))
	}
	// свежими сверху: первая строка — последний снимок
	if revs[0].Snapshot.Percentage != 90 || revs[2].Snapshot.Percentage != 10 {
		t.Fatalf("порядок аудита: %+v", revs)
	}
	if revs[0].ChangedBy != "admin" || revs[0].Snapshot.Key != "roll.flag" {
		t.Fatalf("метаданные правки: %+v", revs[0])
	}

	// limit режет хвост
	if revs, _ := repo.Revisions(ctx, "roll.flag", 2); len(revs) != 2 || revs[0].Snapshot.Percentage != 90 {
		t.Fatalf("limit=2 — две свежих: %+v", revs)
	}

	// аудит переживает удаление флага (без FK — осознанно)
	if _, err := repo.Delete(ctx, "roll.flag"); err != nil {
		t.Fatal(err)
	}
	if revs, err := repo.Revisions(ctx, "roll.flag", 10); err != nil || len(revs) != 3 {
		t.Fatalf("история правок переживает флаг: %d / %v", len(revs), err)
	}
}

// CHECK-констрейнт схемы: процент вне 0..100 не должен пролезать
// мимо валидации сервиса (эшелонированная защита)
func TestSchemaRejectsBadPercentage(t *testing.T) {
	repo := withRepo(t)
	err := repo.Save(context.Background(), domain.Flag{Key: "bad.flag", Percentage: 101})
	if err == nil {
		t.Fatalf("CHECK(percentage) должен отклонить 101")
	}
}

func TestStatementsSplit(t *testing.T) {
	got := statements(schemaSQL)
	if len(got) != 3 {
		t.Fatalf("сегментов схемы = %d, ожидали 3: %q", len(got), got)
	}
}

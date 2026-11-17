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

	"barman-service/internal/domain"
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
	return "postgres://cine:cine@localhost:15432/cine_bar_test"
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
		tcpostgres.WithDatabase("cine_bar_test"),
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

func accepted(id string, createdAt time.Time) domain.Order {
	return domain.Order{
		OrderID: id, UserID: "u-1", Email: "guest@cine.local",
		CustomerName: "Гость " + id,
		SessionID:    "s-1", SessionAt: createdAt.Add(7 * time.Hour), Hall: "IMAX",
		Items: []domain.Item{
			{ItemID: "i-1", Name: "Попкорн солёный", PriceRub: 320, Qty: 2},
			{ItemID: "i-2", Name: "Кола 0,5 л", PriceRub: 220, Qty: 1},
		},
		TotalRub: 860, Status: domain.StatusNew,
		CreatedAt: createdAt, ChangedAt: createdAt,
	}
}

// Полный цикл против живого PG: приём → чтение с полными полями
// (jsonb-позиции, сеанс) → переходы кнопок → доска в три колонки.
func TestUpsertGetSaveBoardRoundtrip(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

	first := accepted("o-1", base)
	second := accepted("o-2", base.Add(time.Minute))
	second.SessionID = "" // заказ без сеанса: NULL в session_at
	second.SessionAt = time.Time{}
	second.Hall = ""
	if err := r.Upsert(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := r.Upsert(ctx, second); err != nil {
		t.Fatal(err)
	}

	got, err := r.Get(ctx, "o-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.CustomerName != first.CustomerName || got.Email != first.Email {
		t.Fatalf("заказ потерял адресата: %+v", got)
	}
	if len(got.Items) != 2 || got.Items[0].Name != "Попкорн солёный" || got.Items[0].Qty != 2 {
		t.Fatalf("jsonb-позиции не пережили запись: %+v", got.Items)
	}
	if got.SessionAt.IsZero() || got.Hall != "IMAX" {
		t.Fatalf("сеанс потерялся: %+v", got)
	}
	noSession, err := r.Get(ctx, "o-2")
	if err != nil {
		t.Fatal(err)
	}
	if !noSession.SessionAt.IsZero() || noSession.Hall != "" {
		t.Fatalf("заказ без сеанса приобрёл сеанс: %+v", noSession)
	}

	// ределивери created не перезаписывает прогресс
	moved, _ := r.Get(ctx, "o-1")
	moved.Status = domain.StatusPreparing
	moved.ChangedAt = base.Add(2 * time.Minute)
	if err := r.Save(ctx, moved); err != nil {
		t.Fatal(err)
	}
	if err := r.Upsert(ctx, accepted("o-1", base)); err != nil {
		t.Fatal(err)
	}
	afterRedelivery, _ := r.Get(ctx, "o-1")
	if afterRedelivery.Status != domain.StatusPreparing {
		t.Fatalf("ределивери сбросил прогресс: %s", afterRedelivery.Status)
	}

	// доска: NEW=1 (o-2), PREPARING=1 (o-1), READY пусто
	board, err := r.Board(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(board.New) != 1 || board.New[0].OrderID != "o-2" {
		t.Fatalf("колонка NEW: %+v", board.New)
	}
	if len(board.Preparing) != 1 || board.Preparing[0].OrderID != "o-1" {
		t.Fatalf("колонка PREPARING: %+v", board.Preparing)
	}
	if len(board.Ready) != 0 {
		t.Fatalf("колонка READY должна быть пуста: %+v", board.Ready)
	}
	if len(board.Recent) != 0 {
		t.Fatalf("лента закрытых должна быть пуста: %+v", board.Recent)
	}

	// закрытые уходят в ленту, свежие сверху
	done, _ := r.Get(ctx, "o-2")
	done.Status = domain.StatusPickedUp
	done.ChangedAt = base.Add(3 * time.Minute)
	if err := r.Save(ctx, done); err != nil {
		t.Fatal(err)
	}
	board, _ = r.Board(ctx)
	if len(board.Recent) != 1 || board.Recent[0].OrderID != "o-2" {
		t.Fatalf("лента закрытых: %+v", board.Recent)
	}
}

// Get несуществующего — доменный ErrOrderNotFound, не сырой sql.ErrNoRows.
func TestGetUnknownOrder(t *testing.T) {
	r := withRepo(t)
	if _, err := r.Get(context.Background(), "no-such"); err != domain.ErrOrderNotFound {
		t.Fatalf("Get неизвестного: %v, ожидался ErrOrderNotFound", err)
	}
}

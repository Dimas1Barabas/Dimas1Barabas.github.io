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

	"analytics-service/internal/domain"
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
	return "postgres://cine:cine@localhost:15432/cine_analytics_test"
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
		tcpostgres.WithDatabase("cine_analytics_test"),
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
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func TestFunnelLifecycle(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	// путь зрителя: открыл модалку, выбрал сеанс, места, создал бронь,
	// открыл оплату — веб-события
	steps := []domain.Event{
		{AID: "aid-1", Type: domain.EventBookingModalOpen, MovieID: "m-1"},
		{AID: "aid-1", Type: domain.EventSessionSelected, MovieID: "m-1", SessionID: "s-1"},
		{AID: "aid-1", Type: domain.EventSeatsSelected, SessionID: "s-1", Count: 2},
		{AID: "aid-1", Type: domain.EventBookingCreated, BookingID: "b-1"},
		{AID: "aid-1", Type: domain.EventPaymentOpened, BookingID: "b-1"},
	}
	for _, e := range steps {
		if err := repo.ApplyWebEvent(ctx, e); err != nil {
			t.Fatalf("%s: %v", e.Type, err)
		}
	}
	// транзакционная сторона: оплатил, воркер подтвердил
	if err := repo.ApplyBookingPaid(ctx, "b-1", "m-1"); err != nil {
		t.Fatalf("paid: %v", err)
	}
	if err := repo.ApplyBookingVerdict(ctx, "b-1", true); err != nil {
		t.Fatalf("verdict: %v", err)
	}

	ins, err := repo.Insights(ctx)
	if err != nil {
		t.Fatalf("insights: %v", err)
	}
	if len(ins.Funnel) != 7 {
		t.Fatalf("воронка из 7 шагов, получили %d: %+v", len(ins.Funnel), ins.Funnel)
	}
	want := []domain.FunnelStep{
		domain.StepModalOpen, domain.StepSessionSelected, domain.StepSeatsSelected,
		domain.StepBookingCreated, domain.StepPaymentOpened, domain.StepPaid,
		domain.StepConfirmed,
	}
	for i, step := range want {
		if ins.Funnel[i].Step != step || ins.Funnel[i].Count != 1 {
			t.Fatalf("шаг %d: ждём %s=1, получили %+v", i, step, ins.Funnel[i])
		}
	}
}

func TestMovieInterestAndConversion(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	// m-1: 4 открытия, 1 бронь (25%); m-2: только смотрят
	for i := 0; i < 4; i++ {
		if err := repo.ApplyWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventBookingModalOpen, MovieID: "m-1"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.ApplyWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventBookingModalOpen, MovieID: "m-2"}); err != nil {
		t.Fatal(err)
	}
	// booking.created пришёл раньше любого открытия m-3 — фильм всё равно
	// появляется в витрине с нулевым интересом
	if err := repo.ApplyBookingPaid(ctx, "b-9", "m-3"); err != nil {
		t.Fatal(err)
	}
	if err := repo.ApplyBookingPaid(ctx, "b-1", "m-1"); err != nil {
		t.Fatal(err)
	}

	ins, err := repo.Insights(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byMovie := map[string]domain.MovieInterest{}
	for _, m := range ins.Movies {
		byMovie[m.MovieID] = m
	}
	if got := byMovie["m-1"]; got.Opens != 4 || got.Bookings != 1 {
		t.Fatalf("m-1: ждём opens=4 bookings=1, получили %+v", got)
	}
	if got := byMovie["m-3"]; got.Opens != 0 || got.Bookings != 1 {
		t.Fatalf("m-3: ждём opens=0 bookings=1, получили %+v", got)
	}
	// сортировка по интересу: m-1 (4) выше m-2 (1) выше m-3 (0)
	if ins.Movies[0].MovieID != "m-1" || ins.Movies[len(ins.Movies)-1].MovieID != "m-3" {
		t.Fatalf("сортировка фильмов по интересу: %+v", ins.Movies)
	}
}

func TestPagesSeatsModalAggregates(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	events := []domain.Event{
		{AID: "a", Type: domain.EventPageView, Route: "home"},
		{AID: "a", Type: domain.EventPageView, Route: "home"},
		{AID: "a", Type: domain.EventPageDwell, Route: "home", MS: 3000},
		{AID: "a", Type: domain.EventPageDwell, Route: "home", MS: 5000},
		{AID: "a", Type: domain.EventSeatClick, Hall: "Красный", Seat: "5-7"},
		{AID: "a", Type: domain.EventSeatClick, Hall: "Красный", Seat: "5-7"},
		{AID: "a", Type: domain.EventSeatClick, Hall: "Красный", Seat: "1-1"},
		{AID: "a", Type: domain.EventModalDwell, MovieID: "m-1", Deepest: "seats", MS: 8000},
		{AID: "a", Type: domain.EventModalDwell, MovieID: "m-1", Deepest: "seats", MS: 4000},
	}
	for _, e := range events {
		if err := repo.ApplyWebEvent(ctx, e); err != nil {
			t.Fatalf("%s: %v", e.Type, err)
		}
	}

	ins, err := repo.Insights(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ins.Pages) != 1 || ins.Pages[0].Route != "home" ||
		ins.Pages[0].Views != 2 || ins.Pages[0].TotalMS != 8000 {
		t.Fatalf("страницы: %+v", ins.Pages)
	}
	if len(ins.Seats) != 2 || ins.Seats[0].Seat != "5-7" || ins.Seats[0].Clicks != 2 {
		t.Fatalf("места (сортировка по кликам): %+v", ins.Seats)
	}
	if len(ins.Modal) != 1 || ins.Modal[0].Deepest != "seats" ||
		ins.Modal[0].Events != 2 || ins.Modal[0].TotalMS != 12000 {
		t.Fatalf("модалка: %+v", ins.Modal)
	}
}

func TestStatementsSplit(t *testing.T) {
	ddl := "-- комментарий с точкой с запятой;\nCREATE TABLE a (x int);\n\nCREATE TABLE b (y text);"
	got := statements(ddl)
	if len(got) != 2 {
		t.Fatalf("ждём 2 стейтмента, получили %d: %q", len(got), got)
	}
	if !strings.HasPrefix(got[0], "CREATE TABLE a") || !strings.HasPrefix(got[1], "CREATE TABLE b") {
		t.Fatalf("стейтменты режутся криво: %q", got)
	}

	// схема пакета обязана резаться без пустых сегментов
	for _, st := range statements(schemaSQL) {
		if strings.TrimSpace(st) == "" {
			t.Fatal("пустой стейтмент в schema.sql")
		}
	}
}

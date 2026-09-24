package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"recommendation-service/internal/domain"
)

// Живые тесты против локального стенда (postgres из docker-compose).
// Базы нет, PG не поднят (локальный прогон без Docker, CI) — честный
// skip, как у e2e API; тестовая база пересоздаётся каждым прогоном.

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_recommendations_test"
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

func bookingSignal(dedup, user, movie, genre string, at time.Time) domain.Signal {
	return domain.Signal{
		UserID: user, MovieID: movie, MovieTitle: "Фильм " + movie, Genre: genre,
		Kind: domain.KindBooking, DedupKey: dedup, OccurredAt: at,
	}
}

func TestAppendListRoundtrip(t *testing.T) {
	r := withRepo(t)
	want := bookingSignal("booking:b-1", "u-1", "m-1", "фантастика",
		time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC))

	if err := r.Append(context.Background(), want); err != nil {
		t.Fatal(err)
	}

	got, err := r.List(context.Background(), "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("прочитано %d сигналов, want 1", len(got))
	}
	s := got[0]
	// timestamptz хранит мгновение: сравниваем только через Equal
	// (зона сессии может отдать другой offset, нс обрезаны до мкс)
	if s.DedupKey != want.DedupKey || s.UserID != want.UserID || s.MovieID != want.MovieID ||
		s.MovieTitle != want.MovieTitle || s.Genre != want.Genre || s.Kind != want.Kind {
		t.Fatalf("roundtrip: %+v, want %+v", s, want)
	}
	if !s.OccurredAt.UTC().Equal(want.OccurredAt) {
		t.Fatalf("OccurredAt = %v, want %v", s.OccurredAt, want.OccurredAt)
	}
}

func TestAppendDedup(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)

	// редоставление одного события — одна строка
	if err := r.Append(ctx, bookingSignal("booking:b-1", "u-1", "m-1", "драма", base)); err != nil {
		t.Fatal(err)
	}
	if err := r.Append(ctx, bookingSignal("booking:b-1", "u-1", "m-1", "драма", base)); err != nil {
		t.Fatal(err)
	}
	// другая бронь того же зрителя — отдельная строка
	if err := r.Append(ctx, bookingSignal("booking:b-2", "u-1", "m-2", "хоррор", base)); err != nil {
		t.Fatal(err)
	}

	got, err := r.List(ctx, "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("сигналов = %d, want 2 (дубль погашен uq_signals_dedup)", len(got))
	}
	if got[0].DedupKey != "booking:b-1" || got[1].DedupKey != "booking:b-2" {
		t.Fatalf("порядок = [%s %s], want [booking:b-1 booking:b-2]", got[0].DedupKey, got[1].DedupKey)
	}
}

func TestListFiltersByUser(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)

	_ = r.Append(ctx, bookingSignal("booking:b-1", "u-1", "m-1", "драма", base))
	_ = r.Append(ctx, bookingSignal("booking:b-2", "u-2", "m-2", "хоррор", base))

	got, err := r.List(ctx, "u-2")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].UserID != "u-2" {
		t.Fatalf("List(u-2) = %+v, want один сигнал u-2", got)
	}

	empty, err := r.List(ctx, "никого")
	if err != nil {
		t.Fatal(err)
	}
	if empty == nil || len(empty) != 0 {
		t.Fatalf("List(нет зрителя) = %v, want пустой не-nil слайс", empty)
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
	if len(sts) != 3 { // таблица + уникальный индекс + индекс
		t.Fatalf("statements = %d, want 3: %q", len(sts), sts)
	}
	for _, st := range sts {
		if !strings.Contains(strings.ToUpper(st), "CREATE") {
			t.Fatalf("стейтмент без CREATE: %q", st)
		}
	}
}

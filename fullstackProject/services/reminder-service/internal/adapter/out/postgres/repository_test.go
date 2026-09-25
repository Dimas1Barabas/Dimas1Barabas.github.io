package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"reminder-service/internal/domain"
)

// Живые тесты против локального стенда (postgres из docker-compose).
// Базы нет, PG не поднят (локальный прогон без Docker, CI) — честный
// skip, как у e2e API; тестовая база пересоздаётся каждым прогоном.

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_reminders_test"
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
	t.Cleanup(func() {
		_ = repo.Close()
		dropDatabase(t, dsn)
	})
	return repo
}

func scheduled(id, userID string, sessionAt, dueAt time.Time) domain.Reminder {
	return domain.Reminder{
		BookingID: id, UserID: userID, Email: userID + "@cine.local",
		MovieID: "m-1", MovieTitle: "Дюна «часть " + id + "»", Hall: "Красный",
		SessionAt: sessionAt, Seats: []string{"5-7", "5-8"},
		DueAt: dueAt, Status: domain.StatusScheduled,
	}
}

func TestScheduleDueListRoundtrip(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	want := scheduled("b-1", "u-1", base.Add(7*time.Hour), base.Add(5*time.Hour))

	if err := r.Schedule(ctx, want); err != nil {
		t.Fatal(err)
	}

	// момент ещё не наступил — Due пуст
	due, err := r.Due(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("Due до срока = %d, want 0", len(due))
	}

	// срок пришёл — напоминание на месте, поля пережили запись
	due, err = r.Due(ctx, base.Add(5*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 {
		t.Fatalf("Due после срока = %d, want 1", len(due))
	}
	got := due[0]
	if got.BookingID != want.BookingID || got.UserID != want.UserID || got.Email != want.Email ||
		got.MovieTitle != want.MovieTitle || got.Hall != want.Hall {
		t.Fatalf("roundtrip: %+v, want %+v", got, want)
	}
	if len(got.Seats) != 2 || got.Seats[0] != "5-7" || got.Seats[1] != "5-8" {
		t.Fatalf("seats = %v, want [5-7 5-8]", got.Seats)
	}
	// timestamptz хранит мгновение: сравниваем только через Equal
	// (зона может отдать другой offset, нс обрезаны до мкс)
	if !got.SessionAt.UTC().Equal(want.SessionAt) || !got.DueAt.UTC().Equal(want.DueAt) {
		t.Fatalf("время: session %v/%v, due %v/%v", got.SessionAt, want.SessionAt, got.DueAt, want.DueAt)
	}

	list, err := r.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Status != domain.StatusScheduled {
		t.Fatalf("List = %+v, want одна SCHEDULED-запись", list)
	}
}

func TestScheduleDedup(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

	// редоставление вердикта — одна строка
	_ = r.Schedule(ctx, scheduled("b-1", "u-1", base.Add(7*time.Hour), base))
	_ = r.Schedule(ctx, scheduled("b-1", "u-1", base.Add(7*time.Hour), base))
	// другая бронь — отдельная строка
	_ = r.Schedule(ctx, scheduled("b-2", "u-1", base.Add(8*time.Hour), base))

	list, err := r.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("записей = %d, want 2 (дубль погашен uq_reminders_booking)", len(list))
	}
}

func TestCancelConditional(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

	_ = r.Schedule(ctx, scheduled("b-1", "u-1", base.Add(7*time.Hour), base.Add(5*time.Hour)))

	if ok, err := r.Cancel(ctx, "b-1"); err != nil || !ok {
		t.Fatalf("отмена SCHEDULED = %v/%v, want true/nil", ok, err)
	}
	// повторная отмена погашенного — false
	if ok, err := r.Cancel(ctx, "b-1"); err != nil || ok {
		t.Fatalf("повторная отмена = %v/%v, want false/nil", ok, err)
	}
	// отсутствующего — false, не ошибка
	if ok, err := r.Cancel(ctx, "b-нет"); err != nil || ok {
		t.Fatalf("отмена отсутствующего = %v/%v, want false/nil", ok, err)
	}
	// погашенное не попадает в Due
	due, err := r.Due(ctx, base.Add(6*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("Due после отмены = %d, want 0", len(due))
	}
}

func TestMarkSentExcludesFromDue(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

	_ = r.Schedule(ctx, scheduled("b-1", "u-1", base.Add(7*time.Hour), base))
	if err := r.MarkSent(ctx, "b-1", base.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	// повторный тик не увидит запись
	due, err := r.Due(ctx, base.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("Due после MarkSent = %d, want 0", len(due))
	}
	list, _ := r.List(ctx)
	if list[0].Status != domain.StatusSent {
		t.Fatalf("статус = %q, want SENT", list[0].Status)
	}
	if list[0].RemindedAt.IsZero() {
		t.Fatal("RemindedAt не заполнен")
	}
}

func TestListFreshFirst(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	base := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	_ = r.Schedule(ctx, scheduled("b-1", "u-1", base.Add(7*time.Hour), base))
	_ = r.Schedule(ctx, scheduled("b-2", "u-1", base.Add(8*time.Hour), base))

	list, err := r.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 || list[0].BookingID != "b-2" {
		t.Fatalf("List = [%s %s], want свежие сверху [b-2 b-1]",
			list[0].BookingID, list[len(list)-1].BookingID)
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
	if len(sts) != 3 { // таблица + уникальный индекс + частичный индекс
		t.Fatalf("statements = %d, want 3: %q", len(sts), sts)
	}
	for _, st := range sts {
		if !strings.Contains(strings.ToUpper(st), "CREATE") {
			t.Fatalf("стейтмент без CREATE: %q", st)
		}
	}
}

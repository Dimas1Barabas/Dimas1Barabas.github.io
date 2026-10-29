package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"outbox-relay/internal/domain"
)

// Живые тесты против Postgres двумя путями: локально — стенд (postgres
// из docker-compose, порт 15432) или TEST_DATABASE_URL, в CI
// (TESTCONTAINERS=1) — одноразовый контейнер testcontainers. Нет ни того,
// ни другого — честный skip; живой прогон в CI делает робот.
//
// В отличие от reminder, релей не создаёт ни базу, ни схему (outbox_messages
// принадлежит миграциям API) — тестовая база и зеркало DDL живут здесь:
// outboxFixtureSQL повторяет 1792886400000-AddOutbox.ts; менять — в паре.

func testDSN() string {
	if v := os.Getenv("TEST_DATABASE_URL"); v != "" {
		return v
	}
	return "postgres://cine:cine@localhost:15432/cine_outbox_test"
}

// зеркало миграции API apps/api/src/migrations/1792886400000-AddOutbox.ts
const outboxFixtureSQL = `CREATE TABLE IF NOT EXISTS outbox_messages (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	routing_key varchar(100) NOT NULL,
	payload jsonb NOT NULL,
	headers jsonb NOT NULL DEFAULT '{}',
	created_at timestamp NOT NULL DEFAULT now(),
	published_at timestamp,
	attempts int NOT NULL DEFAULT 0,
	next_attempt_at timestamp NOT NULL DEFAULT now(),
	last_error text
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
	ON outbox_messages (next_attempt_at) WHERE published_at IS NULL`

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
		tcpostgres.WithDatabase("cine_outbox_test"),
		// без wait-стратегии Run возвращает «running», а не «ready»
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

func requirePostgres(t *testing.T, dsn string) {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("парсинг DSN %q: %v", dsn, err)
	}
	adm := adminDSN(cfg)
	adm.ConnectTimeout = 3 * time.Second

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, adm)
	if err != nil {
		t.Skipf("Postgres недоступен (%v) — live-тесты пропущены", err)
	}
	_ = conn.Close(context.Background())
}

func dropDatabase(t *testing.T, dsn string) {
	t.Helper()
	execAdmin(t, dsn, func(ctx context.Context, conn *pgx.Conn) {
		cfg, _ := pgx.ParseConfig(dsn)
		quoted := `"` + strings.ReplaceAll(cfg.Database, `"`, `""`) + `"`
		if _, err := conn.Exec(ctx, "DROP DATABASE IF EXISTS "+quoted+" WITH (FORCE)"); err != nil {
			t.Fatalf("drop тестовой базы %s: %v", cfg.Database, err)
		}
	})
}

// withRepo поднимает адаптер на чистой тестовой базе: дроп хвоста →
// создать базу → зеркало DDL → NewRepository (пинг fail fast).
func withRepo(t *testing.T) *Repository {
	t.Helper()
	dsn := testDSN()
	requirePostgres(t, dsn)
	dropDatabase(t, dsn)
	execAdmin(t, dsn, func(ctx context.Context, conn *pgx.Conn) {
		cfg, _ := pgx.ParseConfig(dsn)
		quoted := `"` + strings.ReplaceAll(cfg.Database, `"`, `""`) + `"`
		if _, err := conn.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
			t.Fatalf("создание тестовой базы: %v", err)
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cfg, _ := pgx.ParseConfig(dsn)
	dbConn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("коннект к тестовой базе: %v", err)
	}
	for _, st := range strings.Split(outboxFixtureSQL, ";") {
		if s := strings.TrimSpace(st); s != "" {
			if _, err := dbConn.Exec(ctx, s); err != nil {
				t.Fatalf("применение зеркала DDL: %v", err)
			}
		}
	}
	_ = dbConn.Close(context.Background())

	repo, err := NewRepository(ctx, dsn, time.Minute)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() {
		_ = repo.Close()
		dropDatabase(t, dsn)
	})
	return repo
}

func execAdmin(t *testing.T, dsn string, f func(ctx context.Context, conn *pgx.Conn)) {
	t.Helper()
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("парсинг DSN %q: %v", dsn, err)
	}
	adm := adminDSN(cfg)
	adm.ConnectTimeout = 3 * time.Second

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, adm)
	if err != nil {
		t.Fatalf("коннект к служебной базе: %v", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	f(ctx, conn)
}

func adminDSN(cfg *pgx.ConnConfig) *pgx.ConnConfig {
	c := cfg.Copy()
	c.Database = "postgres"
	return c
}

const (
	uuidA = "11111111-1111-1111-1111-111111111111"
	uuidB = "22222222-2222-2222-2222-222222222222"
	uuidC = "33333333-3333-3333-3333-333333333333"
)

func insertOutbox(t *testing.T, r *Repository, id, rk string, createdAt, nextAt time.Time) {
	t.Helper()
	_, err := r.db.Exec(`INSERT INTO outbox_messages
		(id, routing_key, payload, headers, created_at, next_attempt_at)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		id, rk, []byte(`{"bookingId":"`+id+`"}`),
		[]byte(`{"traceparent":"00-11223344556677889900aabbccddeeff-0102030405060708-01"}`),
		createdAt, nextAt)
	if err != nil {
		t.Fatalf("insert outbox %s: %v", id, err)
	}
}

// rowState — снимок записи для ассертов пометок.
func rowState(t *testing.T, r *Repository, id string) (published sql.NullTime, attempts int, nextAt time.Time, lastErr sql.NullString) {
	t.Helper()
	err := r.db.QueryRow(
		`SELECT published_at, attempts, next_attempt_at, last_error
		 FROM outbox_messages WHERE id = $1`, id,
	).Scan(&published, &attempts, &nextAt, &lastErr)
	if err != nil {
		t.Fatalf("чтение записи %s: %v", id, err)
	}
	return
}

func TestDeliverBatchPublishesAndMarks(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	past := time.Now().Add(-time.Minute)
	insertOutbox(t, r, uuidA, "booking.created", past.Add(-time.Second), past)
	insertOutbox(t, r, uuidB, "user.password.reset", past, past)

	var got []domain.Message
	n, err := r.DeliverBatch(ctx, 10, func(_ context.Context, m domain.Message) error {
		got = append(got, m)
		return nil
	})
	if err != nil || n != 2 {
		t.Fatalf("DeliverBatch = %d/%v, want 2/nil", n, err)
	}

	// записи пришли целиком: rk, payload, traceparent из headers
	if len(got) != 2 || got[0].ID != uuidA || got[1].ID != uuidB {
		t.Fatalf("порядок/состав батча: %+v", got)
	}
	// payload хранится jsonb: Postgres печатает каноническую форму
	// (пробел после «:», порядок ключей) — байты вставки НЕ сохраняются.
	// Курьер публикует тело как есть, консьюмеры парсят JSON — продуктово
	// безопасно; тест сверяет смысл, а не побайтовое равенство
	if got[0].RoutingKey != "booking.created" {
		t.Fatalf("routing key записи: %+v", got[0])
	}
	var payload map[string]any
	if err := json.Unmarshal(got[0].Payload, &payload); err != nil {
		t.Fatalf("payload записи %s — не JSON: %v (%s)", uuidA, err, got[0].Payload)
	}
	if payload["bookingId"] != uuidA {
		t.Fatalf("payload записи: %+v (bookingId хочу %s)", payload, uuidA)
	}
	if got[0].Headers["traceparent"] == "" {
		t.Fatalf("traceparent не вычитан: %+v", got[0].Headers)
	}

	for _, id := range []string{uuidA, uuidB} {
		published, attempts, _, lastErr := rowState(t, r, id)
		if !published.Valid || attempts != 0 || lastErr.Valid {
			t.Fatalf("запись %s: published=%v attempts=%d lastErr=%v", id, published, attempts, lastErr)
		}
	}

	st, err := r.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Pending != 0 || !st.OldestPending.IsZero() {
		t.Fatalf("Stats после доставки: %+v", st)
	}
}

func TestDeliverBatchFailureBackoff(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	past := time.Now().Add(-time.Minute)
	insertOutbox(t, r, uuidA, "booking.created", past, past)

	n, err := r.DeliverBatch(ctx, 10, func(context.Context, domain.Message) error {
		return errBrokerDown
	})
	if err != nil || n != 1 {
		t.Fatalf("DeliverBatch с отказом = %d/%v, want 1/nil", n, err)
	}

	published, attempts, nextAt, lastErr := rowState(t, r, uuidA)
	if published.Valid || attempts != 1 || !lastErr.Valid {
		t.Fatalf("после неудачи: published=%v attempts=%d lastErr=%v", published, attempts, lastErr)
	}
	if nextAt.Before(time.Now()) {
		t.Fatalf("next_attempt_at %v не в будущем — бэкофф не сработал", nextAt)
	}

	// следующий тик запись не берёт (пауза), хвост её видит
	n, err = r.DeliverBatch(ctx, 10, func(context.Context, domain.Message) error {
		t.Fatal("запись на паузе не должна была прийти")
		return nil
	})
	if err != nil || n != 0 {
		t.Fatalf("тик по паузе = %d/%v, want 0/nil", n, err)
	}
	st, _ := r.Stats(ctx)
	if st.Pending != 1 {
		t.Fatalf("pending после неудачи = %d, want 1 (не дропаем)", st.Pending)
	}

	// пауза прошла — вторая попытка успешна, last_error гасится
	if _, err := r.db.Exec(`UPDATE outbox_messages
		SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, uuidA); err != nil {
		t.Fatal(err)
	}
	n, err = r.DeliverBatch(ctx, 10, func(context.Context, domain.Message) error { return nil })
	if err != nil || n != 1 {
		t.Fatalf("повторная доставка = %d/%v, want 1/nil", n, err)
	}
	published, attempts, _, lastErr = rowState(t, r, uuidA)
	if !published.Valid || attempts != 1 || lastErr.Valid {
		t.Fatalf("после успеха: published=%v attempts=%d lastErr=%v", published, attempts, lastErr)
	}
}

// TestDeliverBatchSkipsLockedRows — смысл SKIP LOCKED на живой базе:
// один батч держит транзакцию открытой внутри deliver, параллельный батч
// на другом соединении НЕ ждёт и НЕ дублирует заблокированную запись —
// забирает только свободные.
func TestDeliverBatchSkipsLockedRows(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	past := time.Now().Add(-time.Minute)
	insertOutbox(t, r, uuidA, "booking.created", past.Add(-time.Second), past)
	insertOutbox(t, r, uuidB, "booking.cancelled", past, past)

	entered := make(chan domain.Message, 1)
	release := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		// лимит 1: первый батч забирает и блокирует только старейшую
		_, err := r.DeliverBatch(ctx, 1, func(_ context.Context, m domain.Message) error {
			entered <- m
			<-release // держим блокировку uuidA, как будто publish идёт
			return nil
		})
		if err != nil {
			t.Errorf("первый батч: %v", err)
		}
	}()

	locked := <-entered
	if locked.ID != uuidA {
		t.Fatalf("первым должен идти старейший, пришёл %s", locked.ID)
	}

	var second []domain.Message
	n, err := r.DeliverBatch(ctx, 10, func(_ context.Context, m domain.Message) error {
		second = append(second, m)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || len(second) != 1 || second[0].ID != uuidB {
		t.Fatalf("параллельный батч = %d %+v: заблокированная uuidA не должна дублироваться", n, second)
	}

	close(release)
	wg.Wait()

	for _, id := range []string{uuidA, uuidB} {
		if published, _, _, _ := rowState(t, r, id); !published.Valid {
			t.Fatalf("запись %s не опубликована", id)
		}
	}
}

func TestStatsPendingAndOldest(t *testing.T) {
	r := withRepo(t)
	ctx := context.Background()
	now := time.Now()
	insertOutbox(t, r, uuidA, "booking.created", now.Add(-10*time.Minute), now.Add(-time.Minute))
	insertOutbox(t, r, uuidB, "booking.cancelled", now.Add(-5*time.Minute), now.Add(-time.Minute))
	insertOutbox(t, r, uuidC, "booking.created", now.Add(-7*time.Minute), now.Add(-time.Minute))

	st, err := r.Stats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Pending != 3 {
		t.Fatalf("pending = %d, want 3", st.Pending)
	}
	want := now.Add(-10 * time.Minute)
	if !st.OldestPending.UTC().Equal(want.UTC().Truncate(time.Microsecond)) {
		t.Fatalf("oldest = %v, want %v", st.OldestPending, want)
	}
}

// TestNewRepositoryFailFast — без БД: недоступный PG обязан падать сразу,
// молчаливый no-op скрыл бы потерю доставки.
func TestNewRepositoryFailFast(t *testing.T) {
	if _, err := NewRepository(context.Background(),
		"postgres://cine:cine@localhost:9/cine_outbox_test", time.Minute); err == nil {
		t.Fatal("NewRepository на недоступном PG должен вернуть ошибку")
	}
}

var errBrokerDown = &brokerError{}

type brokerError struct{}

func (*brokerError) Error() string {
	return "amqp: connection refused (брокер недоступен)"
}

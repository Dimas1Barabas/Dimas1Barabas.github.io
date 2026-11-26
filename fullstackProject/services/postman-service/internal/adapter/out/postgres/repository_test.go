package postgres

import (
	"context"
	"log"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"postman-service/internal/domain"
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
	return "postgres://cine:cine@localhost:15432/cine_postman_test"
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
		tcpostgres.WithDatabase("cine_postman_test"),
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	admin, err := pgx.ConnectConfig(ctx, adminConfig(cfg))
	if err != nil {
		t.Fatalf("коннект к служебной базе: %v", err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+`"`+cfg.Database+`"`+" WITH (FORCE)"); err != nil {
		t.Fatalf("drop базы %s: %v", cfg.Database, err)
	}
}

// withRepo — свежая база на тест: drop → адаптер сам создаёт базу
// и схему (это тоже проверяется — старт сервиса на пустом кластере).
func withRepo(t *testing.T) *Repository {
	t.Helper()
	dsn := testDSN()
	requirePostgres(t, dsn)
	dropDatabase(t, dsn)
	repo, err := NewRepository(context.Background(), dsn)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func sub(id string) domain.Subscription {
	return domain.Subscription{
		ID:        id,
		URL:       "http://partner.local/hook",
		Secret:    "whsec_" + id,
		Events:    []string{"booking.processed"},
		Active:    true,
		CreatedAt: time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC),
	}
}

func delivery(id, subID, eventID string, status domain.DeliveryStatus, next time.Time) domain.Delivery {
	return domain.Delivery{
		ID:             id,
		SubscriptionID: subID,
		EventID:        eventID,
		EventType:      "booking.processed",
		Payload:        []byte(`{"bookingId":"b-1"}`),
		Status:         status,
		NextAttemptAt:  next,
		CreatedAt:      time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC),
	}
}

func TestSubscriptionStore(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()

	if err := repo.Subs.Add(ctx, sub("whsub_1")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	got, err := repo.Subs.Get(ctx, "whsub_1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.URL != "http://partner.local/hook" || len(got.Events) != 1 || got.Events[0] != "booking.processed" {
		t.Fatalf("подписка искажена: %+v", got)
	}

	if _, err := repo.Subs.Get(ctx, "whsub_netu"); err != domain.ErrSubscriptionNotFound {
		t.Fatalf("чужой id: %v", err)
	}

	list, err := repo.Subs.List(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("List: %v %d", err, len(list))
	}

	deleted, err := repo.Subs.Delete(ctx, "whsub_1")
	if err != nil || !deleted {
		t.Fatalf("Delete: %v %v", deleted, err)
	}
	if again, _ := repo.Subs.Delete(ctx, "whsub_1"); again {
		t.Fatal("повторное удаление должно вернуть false")
	}
}

func TestEnqueueIsIdempotent(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()
	if err := repo.Subs.Add(ctx, sub("whsub_1")); err != nil {
		t.Fatalf("Add: %v", err)
	}

	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	if err := repo.Deliveries.Enqueue(ctx, []domain.Delivery{
		delivery("whdl_1", "whsub_1", "evt_1", domain.StatusQueued, now),
		delivery("whdl_2", "whsub_1", "evt_2", domain.StatusQueued, now),
	}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	// ределивери тех же (подписка, событие) — дублей не заводится
	if err := repo.Deliveries.Enqueue(ctx, []domain.Delivery{
		delivery("whdl_1copy", "whsub_1", "evt_1", domain.StatusQueued, now),
	}); err != nil {
		t.Fatalf("повторный Enqueue: %v", err)
	}
	all, err := repo.Deliveries.List(ctx, domain.DeliveryFilter{})
	if err != nil || len(all) != 2 {
		t.Fatalf("после ределивери должно остаться 2 доставки: %v %d", err, len(all))
	}
}

func TestDueOrderAndSave(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()
	if err := repo.Subs.Add(ctx, sub("whsub_1")); err != nil {
		t.Fatalf("Add: %v", err)
	}

	base := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	if err := repo.Deliveries.Enqueue(ctx, []domain.Delivery{
		delivery("whdl_late", "whsub_1", "evt_late", domain.StatusQueued, base.Add(time.Minute)),
		delivery("whdl_now", "whsub_1", "evt_now", domain.StatusQueued, base),
		delivery("whdl_past", "whsub_1", "evt_past", domain.StatusQueued, base.Add(-time.Minute)),
	}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	due, err := repo.Deliveries.Due(ctx, base, 10)
	if err != nil {
		t.Fatalf("Due: %v", err)
	}
	if len(due) != 2 || due[0].ID != "whdl_past" || due[1].ID != "whdl_now" {
		t.Fatalf("Due берёт не тех/не в порядке: %+v", due)
	}

	// фиксация доставки
	d := due[0]
	d.Status = domain.StatusDelivered
	at := base.Add(5 * time.Second)
	d.DeliveredAt = &at
	if err := repo.Deliveries.Save(ctx, d); err != nil {
		t.Fatalf("Save: %v", err)
	}
	saved, _ := repo.Deliveries.Get(ctx, d.ID)
	if saved.Status != domain.StatusDelivered || saved.DeliveredAt == nil {
		t.Fatalf("доставка не зафиксирована: %+v", saved)
	}

	// очередь тикера больше её не видит
	due, _ = repo.Deliveries.Due(ctx, base.Add(time.Hour), 10)
	if len(due) != 1 || due[0].ID != "whdl_late" {
		t.Fatalf("очередь после доставки: %+v", due)
	}
}

func TestReplaySemantics(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()
	if err := repo.Subs.Add(ctx, sub("whsub_1")); err != nil {
		t.Fatalf("Add: %v", err)
	}

	zero := time.Time{}
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	if err := repo.Deliveries.Enqueue(ctx, []domain.Delivery{
		delivery("whdl_dead", "whsub_1", "evt_dead", domain.StatusDead, zero),
		delivery("whdl_queued", "whsub_1", "evt_q", domain.StatusQueued, now),
	}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	revived, err := repo.Deliveries.Replay(ctx, "whdl_dead", now)
	if err != nil {
		t.Fatalf("Replay dead: %v", err)
	}
	if revived.Status != domain.StatusQueued || revived.Attempts != 0 || !revived.NextAttemptAt.Equal(now) {
		t.Fatalf("replay не сбросил доставку: %+v", revived)
	}

	if _, err := repo.Deliveries.Replay(ctx, "whdl_queued", now); err != domain.ErrNotReplayable {
		t.Fatalf("queued не перепосылается: %v", err)
	}
	if _, err := repo.Deliveries.Replay(ctx, "whdl_netu", now); err != domain.ErrDeliveryNotFound {
		t.Fatalf("чужой id: %v", err)
	}
}

func TestCountsAndFilters(t *testing.T) {
	repo := withRepo(t)
	ctx := context.Background()
	if err := repo.Subs.Add(ctx, sub("whsub_1")); err != nil {
		t.Fatalf("Add: %v", err)
	}

	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	if err := repo.Deliveries.Enqueue(ctx, []domain.Delivery{
		delivery("whdl_1", "whsub_1", "evt_1", domain.StatusQueued, now),
		delivery("whdl_2", "whsub_1", "evt_2", domain.StatusDead, time.Time{}),
	}); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	counts, err := repo.Deliveries.Counts(ctx)
	if err != nil {
		t.Fatalf("Counts: %v", err)
	}
	if counts[domain.StatusQueued] != 1 || counts[domain.StatusDead] != 1 || counts[domain.StatusDelivered] != 0 {
		t.Fatalf("итоги: %+v", counts)
	}

	dead, err := repo.Deliveries.List(ctx, domain.DeliveryFilter{Status: domain.StatusDead})
	if err != nil || len(dead) != 1 || dead[0].ID != "whdl_2" {
		t.Fatalf("фильтр dead: %v %+v", err, dead)
	}
}

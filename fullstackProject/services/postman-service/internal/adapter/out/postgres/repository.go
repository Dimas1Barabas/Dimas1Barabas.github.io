// Package postgres — адаптеры хранилищ «Почтальона»: подписки и
// доставки в собственной базе (по умолчанию cine_postman) общего
// кластера стенда. Базу и схему адаптер создаёт сам при старте:
// initdb-скрипты на уже инициализированном volume pgdata уже
// не сработают.
package postgres

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib" // регистрирует database/sql-драйвер "pgx" в init()

	"postman-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Repository — конверт двух хранилищ за одним пулом: у доменных портов
// совпадают имена методов, один тип оба порта не реализует.
type Repository struct {
	Subs       *Subscriptions
	Deliveries *Deliveries
	db         *sql.DB
}

// NewRepository: DSN → создать базу, если нет → пул → пинг → схема.
// Любая ошибка — fail fast composition root'а: STORAGE=postgres без
// живого PG сервис не стартует, молчаливый fallback на память запрещён.
func NewRepository(ctx context.Context, dsn string) (*Repository, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("парсинг DSN: %w", err)
	}
	if cfg.Database == "" {
		return nil, errors.New("в DSN нет имени базы")
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if err := ensureDatabase(ctx, cfg); err != nil {
		return nil, err
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("открытие пула: %w", err)
	}
	// витрина, консьюмер и тикер редки, пула не надо
	db.SetMaxOpenConns(4)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("пинг Postgres, база %s (PG поднят? docker compose up -d postgres): %w", cfg.Database, err)
	}

	r := &Repository{db: db}
	if err := r.ensureSchema(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	r.Subs = &Subscriptions{db: db}
	r.Deliveries = &Deliveries{db: db}
	return r, nil
}

// Close закрывает пул; знает только composition root, не порты.
func (r *Repository) Close() error { return r.db.Close() }

// — подписки —

// Subscriptions — SubscriptionsStore поверх постгреса.
type Subscriptions struct{ db *sql.DB }

var _ domain.SubscriptionsStore = (*Subscriptions)(nil)

const addSubSQL = `INSERT INTO postman_subscriptions (id, url, secret, events, active, created_at)
	VALUES ($1, $2, $3, $4, $5, $6)`

const getSubSQL = `SELECT id, url, secret, events, active, created_at
	FROM postman_subscriptions WHERE id = $1`

const deleteSubSQL = `DELETE FROM postman_subscriptions WHERE id = $1`

const listSubsSQL = `SELECT id, url, secret, events, active, created_at
	FROM postman_subscriptions ORDER BY created_at DESC`

func (s *Subscriptions) Add(ctx context.Context, sub domain.Subscription) error {
	_, err := s.db.ExecContext(ctx, addSubSQL,
		sub.ID, sub.URL, sub.Secret, csvEvents(sub.Events), sub.Active, sub.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert подписки %s: %w", sub.ID, err)
	}
	return nil
}

func (s *Subscriptions) Get(ctx context.Context, id string) (domain.Subscription, error) {
	row := s.db.QueryRowContext(ctx, getSubSQL, id)
	sub, err := scanSubscription(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Subscription{}, domain.ErrSubscriptionNotFound
	}
	return sub, err
}

func (s *Subscriptions) Delete(ctx context.Context, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx, deleteSubSQL, id)
	if err != nil {
		return false, fmt.Errorf("delete подписки %s: %w", id, err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Subscriptions) List(ctx context.Context) ([]domain.Subscription, error) {
	rows, err := s.db.QueryContext(ctx, listSubsSQL)
	if err != nil {
		return nil, fmt.Errorf("список подписок: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := []domain.Subscription{}
	for rows.Next() {
		sub, err := scanSubscription(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("чтение подписки: %w", err)
		}
		out = append(out, sub)
	}
	return out, rows.Err()
}

func scanSubscription(scan func(dest ...any) error) (domain.Subscription, error) {
	var sub domain.Subscription
	var events string
	if err := scan(&sub.ID, &sub.URL, &sub.Secret, &events, &sub.Active, &sub.CreatedAt); err != nil {
		return domain.Subscription{}, err
	}
	sub.Events = splitEvents(events)
	return sub, nil
}

// — доставки —

// Deliveries — DeliveriesStore поверх постгреса.
type Deliveries struct{ db *sql.DB }

var _ domain.DeliveriesStore = (*Deliveries)(nil)

// Enqueue — батч fan-out одним проходом; идемпотентность сидит на
// уникальном индексе (subscription_id, event_id): повторная вставка
// существующей пары тихо пропускается, как и ределивери брокера.
const enqueueSQL = `INSERT INTO postman_deliveries
	(id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at, created_at)
	VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8)
	ON CONFLICT (subscription_id, event_id) DO NOTHING`

const dueSQL = `SELECT id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at
	FROM postman_deliveries
	WHERE status = 'queued' AND next_attempt_at IS NOT NULL AND next_attempt_at <= $1
	ORDER BY next_attempt_at
	LIMIT $2`

const saveSQL = `UPDATE postman_deliveries
	SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, delivered_at = $6
	WHERE id = $1`

const getDeliverySQL = `SELECT id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at
	FROM postman_deliveries WHERE id = $1`

const replaySQL = `UPDATE postman_deliveries
	SET status = 'queued', attempts = 0, next_attempt_at = $2, last_error = '', delivered_at = NULL
	WHERE id = $1 AND status IN ('delivered', 'dead')
	RETURNING id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at`

const listSQL = `SELECT id, subscription_id, event_id, event_type, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at
	FROM postman_deliveries
	WHERE ($1 = '' OR subscription_id = $1)
	  AND ($2 = '' OR status = $2)
	ORDER BY created_at DESC
	LIMIT $3`

const countsSQL = `SELECT status, count(*) FROM postman_deliveries GROUP BY status`

func (d *Deliveries) Enqueue(ctx context.Context, batch []domain.Delivery) error {
	for _, item := range batch {
		if _, err := d.db.ExecContext(ctx, enqueueSQL,
			item.ID, item.SubscriptionID, item.EventID, item.EventType,
			item.Payload, string(item.Status), item.NextAttemptAt, item.CreatedAt); err != nil {
			return fmt.Errorf("insert доставки %s: %w", item.ID, err)
		}
	}
	return nil
}

func (d *Deliveries) Due(ctx context.Context, now time.Time, limit int) ([]domain.Delivery, error) {
	rows, err := d.db.QueryContext(ctx, dueSQL, now, limit)
	if err != nil {
		return nil, fmt.Errorf("чтение настоевших: %w", err)
	}
	return scanDeliveries(rows)
}

func (d *Deliveries) Save(ctx context.Context, dl domain.Delivery) error {
	var next any
	if !dl.NextAttemptAt.IsZero() {
		next = dl.NextAttemptAt
	}
	var delivered any
	if dl.DeliveredAt != nil {
		delivered = *dl.DeliveredAt
	}
	res, err := d.db.ExecContext(ctx, saveSQL,
		dl.ID, string(dl.Status), dl.Attempts, next, dl.LastError, delivered)
	if err != nil {
		return fmt.Errorf("update доставки %s: %w", dl.ID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrDeliveryNotFound
	}
	return nil
}

func (d *Deliveries) Get(ctx context.Context, id string) (domain.Delivery, error) {
	row := d.db.QueryRowContext(ctx, getDeliverySQL, id)
	dl, err := scanDelivery(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Delivery{}, domain.ErrDeliveryNotFound
	}
	return dl, err
}

// Replay — delivered/dead обратно в очередь; queued не трогает
// (0 строк → ErrNotReplayable), отсутствующая — ErrDeliveryNotFound.
func (d *Deliveries) Replay(ctx context.Context, id string, now time.Time) (domain.Delivery, error) {
	row := d.db.QueryRowContext(ctx, replaySQL, id, now)
	dl, err := scanDelivery(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		// ноль строк — либо доставки нет, либо она queued: различаем
		if _, err := d.Get(ctx, id); err != nil {
			return domain.Delivery{}, err // ErrDeliveryNotFound
		}
		return domain.Delivery{}, domain.ErrNotReplayable
	}
	return dl, err
}

func (d *Deliveries) List(ctx context.Context, f domain.DeliveryFilter) ([]domain.Delivery, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = 50
	}
	rows, err := d.db.QueryContext(ctx, listSQL, f.SubscriptionID, string(f.Status), limit)
	if err != nil {
		return nil, fmt.Errorf("витрина доставок: %w", err)
	}
	return scanDeliveries(rows)
}

func (d *Deliveries) Counts(ctx context.Context) (map[domain.DeliveryStatus]int, error) {
	rows, err := d.db.QueryContext(ctx, countsSQL)
	if err != nil {
		return nil, fmt.Errorf("итоги доставок: %w", err)
	}
	defer func() { _ = rows.Close() }()
	counts := map[domain.DeliveryStatus]int{
		domain.StatusQueued:    0,
		domain.StatusDelivered: 0,
		domain.StatusDead:      0,
	}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return nil, fmt.Errorf("чтение итогов: %w", err)
		}
		counts[domain.DeliveryStatus(status)] = n
	}
	return counts, rows.Err()
}

func scanDeliveries(rows *sql.Rows) ([]domain.Delivery, error) {
	defer func() { _ = rows.Close() }()
	out := []domain.Delivery{}
	for rows.Next() {
		dl, err := scanDelivery(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("чтение строки доставки: %w", err)
		}
		out = append(out, dl)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация доставок: %w", err)
	}
	return out, nil
}

func scanDelivery(scan func(dest ...any) error) (domain.Delivery, error) {
	var dl domain.Delivery
	var status string
	var next, delivered sql.NullTime
	if err := scan(&dl.ID, &dl.SubscriptionID, &dl.EventID, &dl.EventType,
		&dl.Payload, &status, &dl.Attempts, &next, &dl.LastError,
		&dl.CreatedAt, &delivered); err != nil {
		return domain.Delivery{}, err
	}
	dl.Status = domain.DeliveryStatus(status)
	if next.Valid {
		dl.NextAttemptAt = next.Time
	}
	if delivered.Valid {
		t := delivered.Time
		dl.DeliveredAt = &t
	}
	return dl, nil
}

// csvEvents — фильтр подписки одной строкой: ” = все события.
func csvEvents(events []string) string {
	return strings.Join(events, ",")
}

func splitEvents(csv string) []string {
	if csv == "" {
		return nil
	}
	return strings.Split(csv, ",")
}

// ensureDatabase создаёт базу, если её ещё нет. Коннект идёт к служебной
// базе postgres: CREATE DATABASE нельзя ни параметризовать, ни выполнить
// в транзакции, поэтому имя вшивается с экранированием кавычек.
func ensureDatabase(ctx context.Context, cfg *pgx.ConnConfig) error {
	admin, err := pgx.ConnectConfig(ctx, adminConfig(cfg))
	if err != nil {
		return fmt.Errorf("коннект к служебной базе postgres: %w", err)
	}
	defer func() { _ = admin.Close(context.Background()) }()

	var exists bool
	if err := admin.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, cfg.Database,
	).Scan(&exists); err != nil {
		return fmt.Errorf("проверка базы %s: %w", cfg.Database, err)
	}
	if exists {
		return nil
	}
	quoted := `"` + strings.ReplaceAll(cfg.Database, `"`, `""`) + `"`
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P04" {
			return nil // duplicate_database: гонка параллельных стартов, база уже есть
		}
		return fmt.Errorf("создание базы %s: %w", cfg.Database, err)
	}
	return nil
}

// ensureSchema применяет embedded DDL по-стейтментно: расширенный
// протокол pgx не принимает несколько команд в одном Exec.
func (r *Repository) ensureSchema(ctx context.Context) error {
	for _, st := range statements(schemaSQL) {
		if _, err := r.db.ExecContext(ctx, st); err != nil {
			return fmt.Errorf("применение схемы: %w", err)
		}
	}
	return nil
}

// statements режет DDL по «;»; правило файла schema.sql — один
// стейтмент на сегмент, точек с запятой внутри выражений нет.
func statements(ddl string) []string {
	out := []string{}
	for _, st := range strings.Split(stripComments(ddl), ";") {
		if s := strings.TrimSpace(st); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// stripComments выкидывает строки-комментарии «-- ...» целиком.
func stripComments(ddl string) string {
	var b strings.Builder
	for _, line := range strings.Split(ddl, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

// adminConfig копирует конфиг с подменой базы на служебную postgres.
func adminConfig(cfg *pgx.ConnConfig) *pgx.ConnConfig {
	c := cfg.Copy()
	c.Database = "postgres"
	return c
}

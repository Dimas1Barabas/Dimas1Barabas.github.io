// Package postgres — OrderStore-адаптер Бармена: очередь заказов
// кинобара в собственной базе (по умолчанию cine_bar) общего кластера
// стенда. Базу и схему адаптер создаёт сам при старте: initdb-скрипты
// на уже инициализированном volume pgdata уже не сработают.
package postgres

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib" // регистрирует database/sql-драйвер "pgx" в init()

	"barman-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Приём заказа идемпотентен: PK order_id + ON CONFLICT DO NOTHING —
// ределивери bar.order.created не перезаписывает прогресс очереди.
const upsertSQL = `INSERT INTO bar_orders
	(order_id, user_id, email, customer_name, session_id, session_at, hall, items, total_rub, status, created_at, changed_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
	ON CONFLICT (order_id) DO NOTHING`

const getSQL = `SELECT order_id, user_id, email, customer_name, session_id, session_at, hall, items, total_rub, status, created_at, changed_at
	FROM bar_orders WHERE order_id = $1`

const saveSQL = `UPDATE bar_orders SET status = $2, changed_at = $3 WHERE order_id = $1`

// Board — три активные колонки по времени приёма и лента закрытых.
// Активные колонки и лента закрытых отличаются только сортировкой —
// статус приходит параметром.
const boardSQL = `SELECT order_id, user_id, email, customer_name, session_id, session_at, hall, items, total_rub, status, created_at, changed_at
	FROM bar_orders
	WHERE status = ANY($1)
	ORDER BY created_at`

const closedSQL = `SELECT order_id, user_id, email, customer_name, session_id, session_at, hall, items, total_rub, status, created_at, changed_at
	FROM bar_orders
	WHERE status = ANY($1)
	ORDER BY changed_at DESC
	LIMIT 20`

type Repository struct {
	db *sql.DB
}

var _ domain.OrderStore = (*Repository)(nil)

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
	// кнопки витрины и консьюмер редки, пула не надо
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
	return r, nil
}

// Upsert — INSERT ... ON CONFLICT DO NOTHING: дубль ределивери
// незаметен вызывающему, прогресс статуса не сбрасывается.
func (r *Repository) Upsert(ctx context.Context, o domain.Order) error {
	items, err := json.Marshal(o.Items)
	if err != nil {
		return fmt.Errorf("сборка позиций заказа %s: %w", o.OrderID, err)
	}
	_, err = r.db.ExecContext(ctx, upsertSQL,
		o.OrderID, o.UserID, o.Email, o.CustomerName, o.SessionID,
		nullTime(o.SessionAt), o.Hall, items, o.TotalRub,
		string(o.Status), o.CreatedAt, o.ChangedAt)
	if err != nil {
		return fmt.Errorf("insert заказа %s: %w", o.OrderID, err)
	}
	return nil
}

// Get — заказ по id; отсутствие — ErrOrderNotFound домена.
func (r *Repository) Get(ctx context.Context, orderID string) (domain.Order, error) {
	row := r.db.QueryRowContext(ctx, getSQL, orderID)
	o, err := scanOrder(row.Scan)
	if ifErrIsNoRows(err) {
		return domain.Order{}, domain.ErrOrderNotFound
	}
	return o, err
}

// Save — фиксация перехода: статус и время.
func (r *Repository) Save(ctx context.Context, o domain.Order) error {
	res, err := r.db.ExecContext(ctx, saveSQL, o.OrderID, string(o.Status), o.ChangedAt)
	if err != nil {
		return fmt.Errorf("update заказа %s: %w", o.OrderID, err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return domain.ErrOrderNotFound
	}
	return nil
}

// Board — срез очереди для экрана бара: три активные колонки по
// времени приёма + лента закрытых.
func (r *Repository) Board(ctx context.Context) (domain.Board, error) {
	board := domain.Board{
		New:       []domain.Order{},
		Preparing: []domain.Order{},
		Ready:     []domain.Order{},
		Recent:    []domain.Order{},
	}
	fill := func(dst *[]domain.Order, statuses ...string) error {
		rows, err := r.db.QueryContext(ctx, boardSQL, statuses)
		if err != nil {
			return err
		}
		list, err := scanOrders(rows)
		if err != nil {
			return err
		}
		*dst = list
		return nil
	}
	if err := fill(&board.New, string(domain.StatusNew)); err != nil {
		return board, fmt.Errorf("колонка NEW: %w", err)
	}
	if err := fill(&board.Preparing, string(domain.StatusPreparing)); err != nil {
		return board, fmt.Errorf("колонка PREPARING: %w", err)
	}
	if err := fill(&board.Ready, string(domain.StatusReady)); err != nil {
		return board, fmt.Errorf("колонка READY: %w", err)
	}

	closed, err := r.db.QueryContext(ctx, closedSQL,
		[]string{string(domain.StatusPickedUp), string(domain.StatusCancelled)})
	if err != nil {
		return board, fmt.Errorf("лента закрытых: %w", err)
	}
	if board.Recent, err = scanOrders(closed); err != nil {
		return board, fmt.Errorf("лента закрытых: %w", err)
	}
	return board, nil
}

// Close закрывает пул; знает только composition root, не порт.
func (r *Repository) Close() error { return r.db.Close() }

// scanOrder читает колонки общего SELECT; сканер передаётся строкой
// (QueryRow) или набором строк.
func scanOrder(scan func(dest ...any) error) (domain.Order, error) {
	var o domain.Order
	var status string
	var sessionAt sql.NullTime
	var items []byte
	if err := scan(&o.OrderID, &o.UserID, &o.Email, &o.CustomerName,
		&o.SessionID, &sessionAt, &o.Hall, &items, &o.TotalRub,
		&status, &o.CreatedAt, &o.ChangedAt); err != nil {
		return domain.Order{}, err
	}
	o.Status = domain.Status(status)
	if sessionAt.Valid {
		o.SessionAt = sessionAt.Time
	}
	if len(items) > 0 {
		if err := json.Unmarshal(items, &o.Items); err != nil {
			return domain.Order{}, fmt.Errorf("позиции заказа %s: %w", o.OrderID, err)
		}
	}
	return o, nil
}

func scanOrders(rows *sql.Rows) ([]domain.Order, error) {
	defer func() { _ = rows.Close() }()
	out := []domain.Order{}
	for rows.Next() {
		o, err := scanOrder(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("чтение строки заказа: %w", err)
		}
		out = append(out, o)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация заказов: %w", err)
	}
	return out, nil
}

func nullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

func ifErrIsNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
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

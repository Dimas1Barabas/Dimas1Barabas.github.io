// Package postgres — DemandStore-адаптер Тарификатора: проекция спроса
// и история квотов в Postgres, в собственной базе (по умолчанию cine_prices)
// общего кластера стенда. Базу и схему адаптер создаёт сам при старте:
// initdb-скрипты на уже инициализированном volume pgdata уже не сработают.
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

	"pricing-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Применение события — атомарно: строка журнала и проекция одним
// стейтментом CTE. RETURNING сообщает, применилось ли событие
// (дубль по uq_applied_booking_kind вставки не делает).
const applyHeldSQL = `WITH ins AS (
	INSERT INTO applied_events (booking_id, kind)
	VALUES ($1, 'held')
	ON CONFLICT (booking_id, kind) DO NOTHING
	RETURNING booking_id
)
INSERT INTO demand (session_id, occupied, updated_at)
SELECT $2, $3, now()
WHERE EXISTS (SELECT 1 FROM ins)
ON CONFLICT (session_id) DO UPDATE
	SET occupied = demand.occupied + $3, updated_at = now()
RETURNING session_id`

const applyReleasedSQL = `WITH ins AS (
	INSERT INTO applied_events (booking_id, kind)
	VALUES ($1, 'released')
	ON CONFLICT (booking_id, kind) DO NOTHING
	RETURNING booking_id
)
INSERT INTO demand (session_id, occupied, updated_at)
SELECT $2, 0, now()
WHERE EXISTS (SELECT 1 FROM ins)
ON CONFLICT (session_id) DO UPDATE
	SET occupied = GREATEST(demand.occupied - $3, 0), updated_at = now()
RETURNING session_id`

const demandSQL = `SELECT occupied FROM demand WHERE session_id = $1`

const logQuoteSQL = `INSERT INTO quotes (session_id, base_price_rub, price_rub, factors)
	VALUES ($1, $2, $3, $4)`

const listQuotesSQL = `SELECT session_id, base_price_rub, price_rub, factors, created_at
	FROM quotes
	ORDER BY id DESC
	LIMIT 200`

const listDemandSQL = `SELECT session_id, occupied, updated_at
	FROM demand
	ORDER BY session_id`

type Repository struct {
	db *sql.DB
}

var _ domain.DemandStore = (*Repository)(nil)

// NewRepository: DSN → создать базу, если нет → пул → пинг → схема.
// Любая ошибка — fail fast composition root'а: STORAGE=postgres без
// живого PG сервис не стартует, молчаливый fallback запрещён.
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
	// события редки (создание/освобождение брони), квоты — по запросу
	db.SetMaxOpenConns(4)

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("пинг Postgres, база %s (PG поднят? docker compose up -d postgres): %w", cfg.Database, err)
	}

	r := &Repository{db: db}
	if err := r.ensureSchema(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return r, nil
}

// ApplyHeld — «места заняты»: строка журнала + прирост проекции одним
// стейтментом; дубль события (redelivery) ничего не меняет.
func (r *Repository) ApplyHeld(ctx context.Context, sessionID, bookingID string, seats int) (bool, error) {
	applied, err := r.apply(ctx, applyHeldSQL, bookingID, sessionID, seats)
	if err != nil {
		return false, fmt.Errorf("held %s по сеансу %s: %w", bookingID, sessionID, err)
	}
	return applied, nil
}

// ApplyReleased — «места свободны»: GREATEST страхует проекцию от ухода
// в минус (двойное освобождение, дрейф после потери события).
func (r *Repository) ApplyReleased(ctx context.Context, sessionID, bookingID string, seats int) (bool, error) {
	applied, err := r.apply(ctx, applyReleasedSQL, bookingID, sessionID, seats)
	if err != nil {
		return false, fmt.Errorf("released %s по сеансу %s: %w", bookingID, sessionID, err)
	}
	return applied, nil
}

// apply исполняет CTE-стейтмент: вставка в журнал состоялась →
// проекция обновлена; иначе (дубль) — тишина.
func (r *Repository) apply(ctx context.Context, query, bookingID, sessionID string, seats int) (bool, error) {
	rows, err := r.db.QueryContext(ctx, query, bookingID, sessionID, seats)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	applied := rows.Next()
	if err := rows.Err(); err != nil {
		return false, err
	}
	return applied, nil
}

// Demand — занятые места сеанса; нет строки — событий не было, 0.
func (r *Repository) Demand(ctx context.Context, sessionID string) (int, error) {
	var occupied int
	err := r.db.QueryRowContext(ctx, demandSQL, sessionID).Scan(&occupied)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("чтение спроса сеанса %s: %w", sessionID, err)
	}
	return occupied, nil
}

// LogQuote дописывает расчёт в историю (витрина, не бухгалтерия).
func (r *Repository) LogQuote(ctx context.Context, sessionID string, q domain.Quote) error {
	factors := make([]string, 0, len(q.Factors))
	for _, f := range q.Factors {
		factors = append(factors, fmt.Sprintf("%s%+d%%", f.Code, f.Percent))
	}
	if _, err := r.db.ExecContext(ctx, logQuoteSQL,
		sessionID, q.BasePriceRub, q.PriceRub, strings.Join(factors, "; "),
	); err != nil {
		return fmt.Errorf("запись квота сеанса %s: %w", sessionID, err)
	}
	return nil
}

// ListQuotes — витрина: свежими сверху, ограничена 200 строками.
func (r *Repository) ListQuotes(ctx context.Context) ([]domain.QuoteRecord, error) {
	rows, err := r.db.QueryContext(ctx, listQuotesSQL)
	if err != nil {
		return nil, fmt.Errorf("select витрины квотов: %w", err)
	}
	defer rows.Close()
	out := make([]domain.QuoteRecord, 0)
	for rows.Next() {
		var q domain.QuoteRecord
		if err := rows.Scan(&q.SessionID, &q.BasePriceRub, &q.PriceRub, &q.Factors, &q.CreatedAt); err != nil {
			return nil, fmt.Errorf("чтение строки квотов: %w", err)
		}
		out = append(out, q)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация квотов: %w", err)
	}
	return out, nil
}

// ListDemand — витрина: проекция по сеансам.
func (r *Repository) ListDemand(ctx context.Context) ([]domain.DemandRecord, error) {
	rows, err := r.db.QueryContext(ctx, listDemandSQL)
	if err != nil {
		return nil, fmt.Errorf("select витрины спроса: %w", err)
	}
	defer rows.Close()
	out := make([]domain.DemandRecord, 0)
	for rows.Next() {
		var d domain.DemandRecord
		if err := rows.Scan(&d.SessionID, &d.Occupied, &d.UpdatedAt); err != nil {
			return nil, fmt.Errorf("чтение строки спроса: %w", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация спроса: %w", err)
	}
	return out, nil
}

// Close закрывает пул; знает только composition root, не порт.
func (r *Repository) Close() error { return r.db.Close() }

// ensureDatabase создаёт базу, если её ещё нет. Коннект идёт к служебной
// базе postgres: CREATE DATABASE нельзя ни параметризовать, ни выполнить
// в транзакции, поэтому имя вшивается с экранированием кавычек.
func ensureDatabase(ctx context.Context, cfg *pgx.ConnConfig) error {
	admin, err := pgx.ConnectConfig(ctx, adminConfig(cfg))
	if err != nil {
		return fmt.Errorf("коннект к служебной базе postgres: %w", err)
	}
	defer admin.Close(context.Background())

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
// Построчные «--» комментарии убираются до резки: текст файла (со своими
// «;») не должны попадать в исполняемые сегменты.
func statements(ddl string) []string {
	out := []string{}
	for _, st := range strings.Split(stripComments(ddl), ";") {
		if s := strings.TrimSpace(st); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// stripComments выкидывает строки-комментарии «-- ...» целиком;
// инлайновые комментарии в конце строки остаются в сегменте — для
// выполнения это валидный SQL.
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

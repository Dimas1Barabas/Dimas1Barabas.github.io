// Package postgres — DecisionStore-адаптер Детектива: решения в
// Postgres, в собственной базе (по умолчанию cine_detective) общего
// кластера стенда. Базу и схему адаптер создаёт сам при старте:
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

	"detective-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Save — идемпотентная запись: ON CONFLICT DO NOTHING, пустой
// RETURNING означает «решение уже есть» — перечитываем его: повторный
// Score той же брони возвращает первый вердикт, задним числом его
// не меняем (решение могло уйти человеку в ревью).
//
//	$1..$9 факты, $10 score, $11 verdict, $12 reasons, $13 status
const saveSQL = `INSERT INTO decisions
	(booking_id, user_id, session_id, seats_count, total_rub,
	 account_age_days, bookings_24h, cancels_24h, failed_24h,
	 score, verdict, reasons, status)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (booking_id) DO NOTHING
RETURNING ` + recordColumns

// Resolve — условный переход из pending_review: гонку двух админов
// решает WHERE-статус, проигравший получает 0 строк (различаем
// повторным SELECT: не найдено vs уже закрыто).
//
//	$1 booking_id, $2 новый статус, $3 кем решено
const resolveSQL = `UPDATE decisions
	SET status = $2, resolved_by = $3, resolved_at = now()
WHERE booking_id = $1 AND status = 'pending_review'
RETURNING ` + recordColumns

const getSQL = `SELECT ` + recordColumns + ` FROM decisions WHERE booking_id = $1`

// List — витрина: пустой статус — все, свежие сверху, limit режет хвост.
const listSQL = `SELECT ` + recordColumns + `
	FROM decisions
	WHERE ($1 = '' OR status = $1)
	ORDER BY created_at DESC
	LIMIT $2`

// recordColumns — общий список колонок для RETURNING/SELECT: строка
// решения сканируется одним scanRecord.
const recordColumns = `booking_id, user_id, session_id, seats_count, total_rub,
	account_age_days, bookings_24h, cancels_24h, failed_24h,
	score, verdict, reasons, status, resolved_by, resolved_at, created_at`

type Repository struct {
	db *sql.DB
}

var _ domain.DecisionStore = (*Repository)(nil)

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

	if err := ensureDatabase(ctx, cfg); err != nil {
		return nil, err
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("открытие пула: %w", err)
	}
	// каждый чекаут — один Score: темп как у HTTP-запросов API
	db.SetMaxOpenConns(8)

	r := &Repository{db: db}
	if err := r.pingAndSchema(ctx, cfg); err != nil {
		_ = db.Close()
		return nil, err
	}
	return r, nil
}

func (r *Repository) pingAndSchema(ctx context.Context, cfg *pgx.ConnConfig) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := r.db.PingContext(ctx); err != nil {
		return fmt.Errorf("пинг Postgres, база %s (PG поднят? docker compose up -d postgres): %w", cfg.Database, err)
	}
	return r.ensureSchema(ctx)
}

// Save — см. saveSQL об идемпотентности.
func (r *Repository) Save(ctx context.Context, d domain.Decision) (domain.DecisionRecord, error) {
	rows, err := r.db.QueryContext(ctx, saveSQL,
		d.Facts.BookingID, d.Facts.UserID, d.Facts.SessionID,
		d.Facts.SeatsCount, d.Facts.TotalRub, d.Facts.AccountAgeDays,
		d.Facts.Bookings24h, d.Facts.Cancels24h, d.Facts.Failed24h,
		d.Score, string(d.Verdict), strings.Join(d.Reasons, ","),
		string(domain.StatusOf(d.Verdict)),
	)
	if err != nil {
		return domain.DecisionRecord{}, fmt.Errorf("save %s: %w", d.Facts.BookingID, err)
	}
	defer func() { _ = rows.Close() }()
	if rows.Next() {
		return scanRecord(rows)
	}
	if err := rows.Err(); err != nil {
		return domain.DecisionRecord{}, fmt.Errorf("save %s: %w", d.Facts.BookingID, err)
	}
	// строки нет — решение уже записано; перечитываем первый вердикт
	return r.Get(ctx, d.Facts.BookingID)
}

// Resolve — см. resolveSQL; классифицируем пустой RETURNING повторным SELECT.
func (r *Repository) Resolve(ctx context.Context, bookingID string, action domain.ResolveAction, by string) (domain.DecisionRecord, error) {
	status, err := domain.ResolveStatus(action)
	if err != nil {
		return domain.DecisionRecord{}, err
	}
	rows, err := r.db.QueryContext(ctx, resolveSQL, bookingID, string(status), by)
	if err != nil {
		return domain.DecisionRecord{}, fmt.Errorf("resolve %s: %w", bookingID, err)
	}
	defer func() { _ = rows.Close() }()
	if rows.Next() {
		return scanRecord(rows)
	}
	if err := rows.Err(); err != nil {
		return domain.DecisionRecord{}, fmt.Errorf("resolve %s: %w", bookingID, err)
	}
	if _, err := r.Get(ctx, bookingID); err != nil {
		return domain.DecisionRecord{}, err // не найдено
	}
	return domain.DecisionRecord{}, domain.ErrAlreadyResolved
}

// Get — одно решение.
func (r *Repository) Get(ctx context.Context, bookingID string) (domain.DecisionRecord, error) {
	row := r.db.QueryRowContext(ctx, getSQL, bookingID)
	rec, err := scanRecord(row)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.DecisionRecord{}, domain.ErrDecisionNotFound
	}
	return rec, err
}

// List — витрина.
func (r *Repository) List(ctx context.Context, status domain.Status, limit int) ([]domain.DecisionRecord, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := r.db.QueryContext(ctx, listSQL, string(status), limit)
	if err != nil {
		return nil, fmt.Errorf("select витрины решений: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]domain.DecisionRecord, 0)
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация решений: %w", err)
	}
	return out, nil
}

// Close закрывает пул; знает только composition root, не порт.
func (r *Repository) Close() error { return r.db.Close() }

// scanner — общее для *sql.Row и *sql.Rows.
type scanner interface {
	Scan(dest ...any) error
}

func scanRecord(row scanner) (domain.DecisionRecord, error) {
	var rec domain.DecisionRecord
	var verdict, status, reasons string
	var resolvedAt sql.NullTime
	if err := row.Scan(
		&rec.Facts.BookingID, &rec.Facts.UserID, &rec.Facts.SessionID,
		&rec.Facts.SeatsCount, &rec.Facts.TotalRub, &rec.Facts.AccountAgeDays,
		&rec.Facts.Bookings24h, &rec.Facts.Cancels24h, &rec.Facts.Failed24h,
		&rec.Score, &verdict, &reasons, &status,
		&rec.ResolvedBy, &resolvedAt, &rec.CreatedAt,
	); err != nil {
		return domain.DecisionRecord{}, fmt.Errorf("чтение строки решения: %w", err)
	}
	rec.Verdict = domain.Verdict(verdict)
	rec.Status = domain.Status(status)
	rec.Reasons = splitReasons(reasons)
	if resolvedAt.Valid {
		rec.ResolvedAt = resolvedAt.Time
	}
	return rec, nil
}

// splitReasons — коды правил хранятся строкой через запятую; пустая
// строка — пустой список (strings.Split дал бы [""]).
func splitReasons(s string) []string {
	if s == "" {
		return []string{}
	}
	return strings.Split(s, ",")
}

// ensureDatabase создаёт базу, если её ещё нет. Коннект идёт к служебной
// базе postgres: CREATE DATABASE нельзя ни параметризовать, ни выполнить
// в транзакции, поэтому имя вшивается с экранированием кавычек.
func ensureDatabase(ctx context.Context, cfg *pgx.ConnConfig) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

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
// Построчные «--» комментарии убираются до резки: текст файла (со своими
// «;») не должен попадать в исполняемые сегменты.
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

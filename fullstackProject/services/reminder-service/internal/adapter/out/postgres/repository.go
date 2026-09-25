// Package postgres — ReminderStore-адаптер: очередь напоминаний
// в Postgres, в собственной базе (по умолчанию cine_reminders) общего
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

	"reminder-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Schedule идемпотентен: редоставление вердикта (брокер доставляет
// at-least-once) гасится конфликтом по uq_reminders_booking.
const insertSQL = `INSERT INTO reminders
	(booking_id, user_id, email, movie_id, movie_title, hall, session_at, seats, due_at, status)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	ON CONFLICT (booking_id) DO NOTHING`

// Cancel и MarkSent условны по статусу: ушедшее письмо не отзывать,
// повторную отмену не фиксировать.
const cancelSQL = `UPDATE reminders SET status = 'CANCELLED'
	WHERE booking_id = $1 AND status = 'SCHEDULED'`

const markSentSQL = `UPDATE reminders SET status = 'SENT', reminded_at = $2
	WHERE booking_id = $1 AND status = 'SCHEDULED'`

// Тикер читает пачкой: LIMIT страхует от шторма накопившихся
// после простоя напоминаний.
const dueSQL = `SELECT booking_id, user_id, email, movie_id, movie_title, hall, session_at, seats, due_at, status, reminded_at
	FROM reminders
	WHERE status = 'SCHEDULED' AND due_at <= $1
	ORDER BY due_at
	LIMIT 100`

const listSQL = `SELECT booking_id, user_id, email, movie_id, movie_title, hall, session_at, seats, due_at, status, reminded_at
	FROM reminders
	ORDER BY id DESC
	LIMIT 200`

type Repository struct {
	db *sql.DB
}

var _ domain.ReminderStore = (*Repository)(nil)

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
	// тикер ходит пачкой раз в период, gRPC-запросы редкие — пула не надо
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

// Schedule — INSERT ... ON CONFLICT DO NOTHING: дубль редоставления
// незаметен вызывающему.
func (r *Repository) Schedule(ctx context.Context, rem domain.Reminder) error {
	_, err := r.db.ExecContext(ctx, insertSQL,
		rem.BookingID, rem.UserID, rem.Email, rem.MovieID, rem.MovieTitle,
		rem.Hall, rem.SessionAt, strings.Join(rem.Seats, ","), rem.DueAt, string(rem.Status))
	if err != nil {
		return fmt.Errorf("insert напоминания %s: %w", rem.BookingID, err)
	}
	return nil
}

// Cancel возвращает, была ли погашена SCHEDULED-запись.
func (r *Repository) Cancel(ctx context.Context, bookingID string) (bool, error) {
	res, err := r.db.ExecContext(ctx, cancelSQL, bookingID)
	if err != nil {
		return false, fmt.Errorf("отмена напоминания %s: %w", bookingID, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("отмена напоминания %s: строки: %w", bookingID, err)
	}
	return n > 0, nil
}

// Due — наступившие к моменту now, старшими вперёд.
func (r *Repository) Due(ctx context.Context, now time.Time) ([]domain.Reminder, error) {
	rows, err := r.db.QueryContext(ctx, dueSQL, now)
	if err != nil {
		return nil, fmt.Errorf("select наступивших: %w", err)
	}
	return scanReminders(rows)
}

// MarkSent — условный UPDATE; ноль строк не ошибка (дубль тика).
func (r *Repository) MarkSent(ctx context.Context, bookingID string, at time.Time) error {
	if _, err := r.db.ExecContext(ctx, markSentSQL, bookingID, at); err != nil {
		return fmt.Errorf("отметка отправленным %s: %w", bookingID, err)
	}
	return nil
}

// List — витрина: свежими сверху, ограничена 200 строками.
func (r *Repository) List(ctx context.Context) ([]domain.Reminder, error) {
	rows, err := r.db.QueryContext(ctx, listSQL)
	if err != nil {
		return nil, fmt.Errorf("select витрины: %w", err)
	}
	return scanReminders(rows)
}

// Close закрывает пул; знает только composition root, не порт.
func (r *Repository) Close() error { return r.db.Close() }

// scanReminders читает общий SELECT-набор колонок; слайс всегда
// непустой (len 0, не nil).
func scanReminders(rows *sql.Rows) ([]domain.Reminder, error) {
	defer rows.Close()
	out := make([]domain.Reminder, 0)
	for rows.Next() {
		var rem domain.Reminder
		var status string
		var seats string
		var remindedAt sql.NullTime
		if err := rows.Scan(&rem.BookingID, &rem.UserID, &rem.Email, &rem.MovieID,
			&rem.MovieTitle, &rem.Hall, &rem.SessionAt, &seats, &rem.DueAt,
			&status, &remindedAt); err != nil {
			return nil, fmt.Errorf("чтение строки напоминаний: %w", err)
		}
		rem.Status = domain.Status(status)
		if seats != "" {
			rem.Seats = strings.Split(seats, ",")
		} else {
			rem.Seats = nil
		}
		if remindedAt.Valid {
			rem.RemindedAt = remindedAt.Time
		}
		out = append(out, rem)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация напоминаний: %w", err)
	}
	return out, nil
}

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

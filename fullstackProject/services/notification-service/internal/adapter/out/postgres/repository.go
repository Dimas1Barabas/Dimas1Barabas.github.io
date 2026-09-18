// Package postgres — Repository-адаптер: история уведомлений в Postgres,
// в собственной базе (по умолчанию cine_notifications) общего кластера
// стенда. Базу и схему адаптер создаёт сам при старте: initdb-скрипты
// на уже инициализированном volume pgdata уже не сработают.
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

	"notification-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// defaultLimit — паритет с memory-адаптером: use-case клампит лимит
// раньше, но порт разрешает звать репозиторий напрямую.
const defaultLimit = 50

const insertSQL = `INSERT INTO notifications
	(id, booking_id, kind, title, body, channel, status, error, created_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`

// id доопределяет порядок при равных created_at: фабрика домена кодирует
// в него UTC-timestamp, лексикографически согласованный со временем.
const listSQL = `SELECT id, booking_id, kind, title, body, channel, status, error, created_at
	FROM notifications
	WHERE ($1 = '' OR booking_id = $1)
	ORDER BY created_at DESC, id DESC
	LIMIT $2`

type Repository struct {
	db *sql.DB
}

var _ domain.Repository = (*Repository)(nil)

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
	// консьюмер ходит с prefetch=1, HTTP-опрос редкий — большого пула не надо
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

// Save — один INSERT. Ошибка считается транзиентной: use-case вернёт её
// консьюмеру, и брокер ретраит сохранение (как и любой другой сбой).
func (r *Repository) Save(ctx context.Context, n domain.Notification) error {
	_, err := r.db.ExecContext(ctx, insertSQL,
		n.ID, n.BookingID, string(n.Kind), n.Title, n.Body, n.Channel,
		string(n.Status), n.Error, n.CreatedAt)
	if err != nil {
		return fmt.Errorf("insert уведомления %s: %w", n.ID, err)
	}
	return nil
}

// List — новые сверху, фильтр по брони, лимит; Limit <= 0 — дефолт
// адаптера. Слайс всегда непустой (len 0, не nil), чтобы HTTP-адаптер
// отдавал «[]», а не «null».
func (r *Repository) List(ctx context.Context, f domain.Filter) ([]domain.Notification, error) {
	if f.Limit <= 0 {
		f.Limit = defaultLimit
	}
	rows, err := r.db.QueryContext(ctx, listSQL, f.BookingID, f.Limit)
	if err != nil {
		return nil, fmt.Errorf("select истории: %w", err)
	}
	defer rows.Close()

	out := make([]domain.Notification, 0, f.Limit)
	for rows.Next() {
		var n domain.Notification
		var kind, status string
		if err := rows.Scan(&n.ID, &n.BookingID, &kind, &n.Title, &n.Body,
			&n.Channel, &status, &n.Error, &n.CreatedAt); err != nil {
			return nil, fmt.Errorf("чтение строки истории: %w", err)
		}
		n.Kind, n.Status = domain.Kind(kind), domain.DeliveryStatus(status)
		out = append(out, n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация истории: %w", err)
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

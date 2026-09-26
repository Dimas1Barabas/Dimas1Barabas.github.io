// Package postgres — BucketStore-адаптер Привратника: token-корзины
// в Postgres, в собственной базе (по умолчанию cine_ratekeeper) общего
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

	"ratelimiter-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Take — атомарный «долив + списание» одним стейтментом: RETURNING
// отдаёт и новый остаток, и вердикт (last_taken), оба значения — из
// одного снапшота строки. Первый визит — ветка UNION ALL: корзины ещё
// нет, refill пуст — считаем её полной и списываем сразу. last_taken
// именно колонка, а не выражение в RETURNING: RETURNING гарантированно
// видит только колонки целевой таблицы, а остаток 0.4 после списания
// неотличим от отказа с 0.4 без явного следа. Гонка двух одновременных
// «первых визитов» может недосчитать один токен — на стендовых
// масштабах осознанно (строже — только advisory lock или сериализация).
//
//	$1 action, $2 key, $3 capacity, $4 refill/сек
const takeSQL = `WITH refill AS (
	SELECT LEAST(
		$3::float8,
		buckets.tokens + GREATEST(EXTRACT(EPOCH FROM (now() - buckets.updated_at))::float8, 0) * $4::float8
	) AS tokens
	FROM buckets
	WHERE action = $1 AND client_key = $2
), nxt AS (
	SELECT CASE WHEN r.tokens >= 1 THEN r.tokens - 1 ELSE r.tokens END AS tokens,
	       r.tokens >= 1 AS taken
	FROM refill r
	UNION ALL
	SELECT $3::float8 - 1, TRUE
	WHERE NOT EXISTS (SELECT 1 FROM refill)
)
INSERT INTO buckets (action, client_key, tokens, last_taken, updated_at)
SELECT $1, $2, tokens, taken, now() FROM nxt
ON CONFLICT (action, client_key) DO UPDATE
	SET tokens = EXCLUDED.tokens,
	    last_taken = EXCLUDED.last_taken,
	    updated_at = now()
RETURNING last_taken, tokens`

const listBucketsSQL = `SELECT action, client_key, tokens, last_taken, updated_at
	FROM buckets
	ORDER BY updated_at DESC
	LIMIT 200`

type Repository struct {
	db *sql.DB
}

var _ domain.BucketStore = (*Repository)(nil)

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
	// каждая проверка гварда — один Take: темп как у HTTP-запросов API
	db.SetMaxOpenConns(8)

	r := &Repository{db: db}
	if err := r.pingAndSchema(ctx, cfg); err != nil {
		db.Close()
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

// Take — снять токен корзины; см. takeSQL об атомарности.
func (r *Repository) Take(ctx context.Context, action domain.Action, key string, p domain.Policy) (bool, float64, error) {
	var taken bool
	var remaining float64
	// INSERT..SELECT..ON CONFLICT пишет ровно одну строку — QueryRow
	if err := r.db.QueryRowContext(ctx, takeSQL, string(action), key, p.Capacity, p.RefillPerSec).
		Scan(&taken, &remaining); err != nil {
		return false, 0, fmt.Errorf("take %s/%s: %w", action, key, err)
	}
	return taken, remaining, nil
}

// ListBuckets — витрина: свежими сверху, ограничена 200 строками.
func (r *Repository) ListBuckets(ctx context.Context) ([]domain.BucketRecord, error) {
	rows, err := r.db.QueryContext(ctx, listBucketsSQL)
	if err != nil {
		return nil, fmt.Errorf("select витрины корзин: %w", err)
	}
	defer rows.Close()
	out := make([]domain.BucketRecord, 0)
	for rows.Next() {
		var b domain.BucketRecord
		if err := rows.Scan(&b.Action, &b.Key, &b.Tokens, &b.Taken, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("чтение строки корзины: %w", err)
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация корзин: %w", err)
	}
	return out, nil
}

// Close закрывает пул; знает только composition root, не порт.
func (r *Repository) Close() error { return r.db.Close() }

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

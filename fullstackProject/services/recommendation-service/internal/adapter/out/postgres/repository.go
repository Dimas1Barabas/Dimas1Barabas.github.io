// Package postgres — SignalStore-адаптер: история сигналов в Postgres,
// в собственной базе (по умолчанию cine_recommendations) общего кластера
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

	"recommendation-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Append идемпотентен: редоставление события (брокер доставляет
// at-least-once) гасится конфликтом по uq_signals_dedup.
const insertSQL = `INSERT INTO signals
	(dedup_key, user_id, movie_id, movie_title, genre, kind, rating, occurred_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	ON CONFLICT (dedup_key) DO NOTHING`

// id монотонен — порядок поступления сигналов стабилен между прогонами.
const listSQL = `SELECT dedup_key, user_id, movie_id, movie_title, genre, kind, rating, occurred_at
	FROM signals
	WHERE user_id = $1
	ORDER BY id`

type Repository struct {
	db *sql.DB
}

var _ domain.SignalStore = (*Repository)(nil)

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
	// консьюмер ходит с prefetch=1, gRPC-запросы редкие — большого пула не надо
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

// Append — INSERT ... ON CONFLICT DO NOTHING: дубль редоставления
// незаметен вызывающему. Ошибка считается транзиентной: консьюмер
// ретраит вставку через retry-очередь.
func (r *Repository) Append(ctx context.Context, s domain.Signal) error {
	_, err := r.db.ExecContext(ctx, insertSQL,
		s.DedupKey, s.UserID, s.MovieID, s.MovieTitle, s.Genre,
		string(s.Kind), s.Rating, s.OccurredAt)
	if err != nil {
		return fmt.Errorf("insert сигнала %s: %w", s.DedupKey, err)
	}
	return nil
}

// List — вся история сигналов зрителя; слайс всегда непустой (len 0,
// не nil), чтобы профиль собирался без nil-проверок.
func (r *Repository) List(ctx context.Context, userID string) ([]domain.Signal, error) {
	rows, err := r.db.QueryContext(ctx, listSQL, userID)
	if err != nil {
		return nil, fmt.Errorf("select сигналов: %w", err)
	}
	defer rows.Close()

	out := make([]domain.Signal, 0)
	for rows.Next() {
		var s domain.Signal
		var kind string
		if err := rows.Scan(&s.DedupKey, &s.UserID, &s.MovieID, &s.MovieTitle,
			&s.Genre, &kind, &s.Rating, &s.OccurredAt); err != nil {
			return nil, fmt.Errorf("чтение строки сигналов: %w", err)
		}
		s.Kind = domain.SignalKind(kind)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация сигналов: %w", err)
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

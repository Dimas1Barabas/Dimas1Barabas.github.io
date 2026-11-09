// Package postgres — FlagStore-адаптер «Суфлёра»: флаги и аудит правок
// в Postgres, в собственной базе (по умолчанию cine_flags) общего
// кластера стенда. Базу и схему адаптер создаёт сам при старте:
// initdb-скрипты на уже инициализированном volume pgdata уже не сработают.
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

	"flags-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

const (
	getSQL = `SELECT key, description, enabled, percentage, killed, variants, updated_by, updated_at
		FROM flags WHERE key = $1`

	listSQL = `SELECT key, description, enabled, percentage, killed, variants, updated_by, updated_at
		FROM flags ORDER BY key`

	// Save: upsert флага и строка аудита — одной транзакцией: снимок
	// аудита не может разъехаться с состоянием флага
	saveFlagSQL = `INSERT INTO flags (key, description, enabled, percentage, killed, variants, updated_by, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (key) DO UPDATE
		SET description = EXCLUDED.description,
		    enabled = EXCLUDED.enabled,
		    percentage = EXCLUDED.percentage,
		    killed = EXCLUDED.killed,
		    variants = EXCLUDED.variants,
		    updated_by = EXCLUDED.updated_by,
		    updated_at = EXCLUDED.updated_at`

	saveRevisionSQL = `INSERT INTO flag_revisions (key, changed_by, changed_at, description, enabled, percentage, killed, variants)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

	deleteSQL = `DELETE FROM flags WHERE key = $1`

	revisionsSQL = `SELECT key, changed_by, changed_at, description, enabled, percentage, killed, variants
		FROM flag_revisions WHERE key = $1 ORDER BY id DESC LIMIT $2`

	// метрики экспериментов: строка заводится по первому отчёту, дальше
	// атомарный инкремент — конкурентные отчёты не теряют +1
	statAddSQL = `INSERT INTO flag_experiment_stats (key, variant, exposures, conversions)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (key, variant) DO UPDATE
		SET exposures = flag_experiment_stats.exposures + EXCLUDED.exposures,
		    conversions = flag_experiment_stats.conversions + EXCLUDED.conversions`

	statsSQL = `SELECT key, variant, exposures, conversions
		FROM flag_experiment_stats ORDER BY key, variant`
)

type Repository struct {
	db *sql.DB
}

var (
	_ domain.FlagStore       = (*Repository)(nil)
	_ domain.ExperimentStore = (*Repository)(nil)
)

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
	// темп — как у HTTP-запросов API: вердикты и правки короткие
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

// Get — снимок флага; found=false, если ряда нет.
func (r *Repository) Get(ctx context.Context, key string) (domain.Flag, bool, error) {
	var f domain.Flag
	var variants []byte
	err := r.db.QueryRowContext(ctx, getSQL, key).Scan(
		&f.Key, &f.Description, &f.Enabled, &f.Percentage, &f.Killed, &variants, &f.UpdatedBy, &f.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Flag{}, false, nil
	}
	if err != nil {
		return domain.Flag{}, false, fmt.Errorf("get флага %s: %w", key, err)
	}
	f.Variants = parseVariants(variants)
	return f, true, nil
}

// List — все флаги по ключу (снимок детерминирован).
func (r *Repository) List(ctx context.Context) ([]domain.Flag, error) {
	rows, err := r.db.QueryContext(ctx, listSQL)
	if err != nil {
		return nil, fmt.Errorf("select витрины флагов: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]domain.Flag, 0)
	for rows.Next() {
		var f domain.Flag
		var variants []byte
		if err := rows.Scan(&f.Key, &f.Description, &f.Enabled, &f.Percentage, &f.Killed, &variants, &f.UpdatedBy, &f.UpdatedAt); err != nil {
			return nil, fmt.Errorf("чтение строки флага: %w", err)
		}
		f.Variants = parseVariants(variants)
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация флагов: %w", err)
	}
	return out, nil
}

// Save — upsert флага + строка аудита одной транзакцией: снимок аудита
// и состояние флага не могут разъехаться (атомарность outbox-урока:
// либо обе записи, либо никакой).
func (r *Repository) Save(ctx context.Context, f domain.Flag) error {
	variants, err := variantsJSON(f.Variants)
	if err != nil {
		return fmt.Errorf("сериализация вариантов %s: %w", f.Key, err)
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin save: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // no-op после Commit

	if _, err := tx.ExecContext(ctx, saveFlagSQL,
		f.Key, f.Description, f.Enabled, f.Percentage, f.Killed, variants, f.UpdatedBy, f.UpdatedAt,
	); err != nil {
		return fmt.Errorf("upsert флага %s: %w", f.Key, err)
	}
	if _, err := tx.ExecContext(ctx, saveRevisionSQL,
		f.Key, f.UpdatedBy, f.UpdatedAt, f.Description, f.Enabled, f.Percentage, f.Killed, variants,
	); err != nil {
		return fmt.Errorf("аудит правки %s: %w", f.Key, err)
	}
	return tx.Commit()
}

// Delete — убрать флаг; false, если ряда не было. Аудит не трогаем:
// история правок переживает флаг.
func (r *Repository) Delete(ctx context.Context, key string) (bool, error) {
	res, err := r.db.ExecContext(ctx, deleteSQL, key)
	if err != nil {
		return false, fmt.Errorf("delete флага %s: %w", key, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete флага %s: rows affected: %w", key, err)
	}
	return n > 0, nil
}

// Revisions — аудит правок флага, свежими сверху.
func (r *Repository) Revisions(ctx context.Context, key string, limit int) ([]domain.Revision, error) {
	rows, err := r.db.QueryContext(ctx, revisionsSQL, key, limit)
	if err != nil {
		return nil, fmt.Errorf("select аудита %s: %w", key, err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]domain.Revision, 0)
	for rows.Next() {
		var rev domain.Revision
		var variants []byte
		if err := rows.Scan(
			&rev.Key, &rev.ChangedBy, &rev.ChangedAt,
			&rev.Snapshot.Description, &rev.Snapshot.Enabled, &rev.Snapshot.Percentage, &rev.Snapshot.Killed,
			&variants,
		); err != nil {
			return nil, fmt.Errorf("чтение строки аудита: %w", err)
		}
		rev.Snapshot.Key = rev.Key
		rev.Snapshot.Variants = parseVariants(variants)
		rev.Snapshot.UpdatedAt = rev.ChangedAt
		rev.Snapshot.UpdatedBy = rev.ChangedBy
		out = append(out, rev)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация аудита: %w", err)
	}
	return out, nil
}

// Add — +1 к экспозиции/конверсии варианта: upsert с атомарным
// инкрементом, конкурентные отчёты не теряют счёт.
func (r *Repository) Add(ctx context.Context, key, variant string, conversion bool) error {
	var exposures, conversions int
	if conversion {
		conversions = 1
	} else {
		exposures = 1
	}
	if _, err := r.db.ExecContext(ctx, statAddSQL, key, variant, exposures, conversions); err != nil {
		return fmt.Errorf("инкремент метрик %s/%s: %w", key, variant, err)
	}
	return nil
}

// Stats — таблица метрик экспериментов, отсортирована (флаг, вариант).
func (r *Repository) Stats(ctx context.Context) ([]domain.VariantStat, error) {
	rows, err := r.db.QueryContext(ctx, statsSQL)
	if err != nil {
		return nil, fmt.Errorf("select метрик экспериментов: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]domain.VariantStat, 0)
	for rows.Next() {
		var st domain.VariantStat
		if err := rows.Scan(&st.Key, &st.Variant, &st.Exposures, &st.Conversions); err != nil {
			return nil, fmt.Errorf("чтение строки метрик: %w", err)
		}
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация метрик: %w", err)
	}
	return out, nil
}

// variantsJSON — варианты в jsonb: «[]» — обычный флаг без эксперимента.
func variantsJSON(vs []domain.Variant) ([]byte, error) {
	if len(vs) == 0 {
		return []byte("[]"), nil
	}
	return json.Marshal(vs)
}

// parseVariants — jsonb в варианты; битый JSON не роняет витрину —
// флаг читается как обычный (без эксперимента).
func parseVariants(data []byte) []domain.Variant {
	if len(data) == 0 {
		return nil
	}
	var vs []domain.Variant
	if err := json.Unmarshal(data, &vs); err != nil {
		return nil
	}
	return vs
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

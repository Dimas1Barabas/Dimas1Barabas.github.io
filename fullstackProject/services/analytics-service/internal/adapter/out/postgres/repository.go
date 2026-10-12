// Package postgres — AnalyticsStore-адаптер Аналитика: агрегаты
// поведения в Postgres, в собственной базе (по умолчанию cine_analytics)
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

	"analytics-service/internal/domain"
)

//go:embed schema.sql
var schemaSQL string

// Все записи — UPSERT-инкременты: события at-least-once, редкий дубль
// клика аналитике не страшен, зато ничего не теряется.
const (
	incrFunnelSQL = `INSERT INTO funnel (step, count) VALUES ($1, 1)
		ON CONFLICT (step) DO UPDATE SET count = funnel.count + 1`

	incrMovieOpensSQL = `INSERT INTO movie_interest (movie_id, opens) VALUES ($1, 1)
		ON CONFLICT (movie_id) DO UPDATE SET opens = movie_interest.opens + 1`

	incrMovieBookingsSQL = `INSERT INTO movie_interest (movie_id, bookings) VALUES ($1, 1)
		ON CONFLICT (movie_id) DO UPDATE SET bookings = movie_interest.bookings + 1`

	incrPageViewSQL = `INSERT INTO page_stats (route, views) VALUES ($1, 1)
		ON CONFLICT (route) DO UPDATE SET views = page_stats.views + 1`

	addPageDwellSQL = `INSERT INTO page_stats (route, views, dwell_ms) VALUES ($1, 0, $2)
		ON CONFLICT (route) DO UPDATE SET dwell_ms = page_stats.dwell_ms + $2`

	incrSeatSQL = `INSERT INTO seat_heat (hall, seat, clicks) VALUES ($1, $2, 1)
		ON CONFLICT (hall, seat) DO UPDATE SET clicks = seat_heat.clicks + 1`

	addModalSQL = `INSERT INTO modal_stats (deepest, events, total_ms) VALUES ($1, 1, $2)
		ON CONFLICT (deepest) DO UPDATE SET
			events = modal_stats.events + 1,
			total_ms = modal_stats.total_ms + $2`
)

const (
	listFunnelSQL = `SELECT step, count FROM funnel`
	listMoviesSQL = `SELECT movie_id, opens, bookings FROM movie_interest
		ORDER BY opens DESC, movie_id LIMIT 20`
	listPagesSQL = `SELECT route, views, dwell_ms FROM page_stats ORDER BY route`
	listSeatsSQL = `SELECT hall, seat, clicks FROM seat_heat
		ORDER BY clicks DESC, hall, seat LIMIT 400`
	listModalSQL = `SELECT deepest, events, total_ms FROM modal_stats ORDER BY deepest`
)

type Repository struct {
	db *sql.DB
}

var _ domain.AnalyticsStore = (*Repository)(nil)

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
	// события частые (клики, страницы), витрина — по запросу
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

// ApplyWebEvent раскладывает событие по агрегатам — каждый инкремент
// отдельным UPSERT: у события ровно одна роль в каждом агрегате.
func (r *Repository) ApplyWebEvent(ctx context.Context, e domain.Event) error {
	if step, ok := domain.FunnelStepOf[e.Type]; ok {
		if _, err := r.db.ExecContext(ctx, incrFunnelSQL, step); err != nil {
			return fmt.Errorf("воронка %s: %w", step, err)
		}
	}

	switch e.Type {
	case domain.EventBookingModalOpen:
		return r.exec(ctx, incrMovieOpensSQL, "открытие фильма", e.MovieID)
	case domain.EventModalDwell:
		return r.exec(ctx, addModalSQL, "время в модалке", e.Deepest, e.MS)
	case domain.EventPageView:
		return r.exec(ctx, incrPageViewSQL, "просмотр страницы", e.Route)
	case domain.EventPageDwell:
		return r.exec(ctx, addPageDwellSQL, "время на странице", e.Route, e.MS)
	case domain.EventSeatClick:
		return r.exec(ctx, incrSeatSQL, "клик по месту", e.Hall, e.Seat)
	}
	return nil
}

// ApplyBookingPaid — воронка paid + бронирование фильма.
func (r *Repository) ApplyBookingPaid(ctx context.Context, _, movieID string) error {
	if err := r.exec(ctx, incrFunnelSQL, "воронка paid", domain.StepPaid); err != nil {
		return err
	}
	return r.exec(ctx, incrMovieBookingsSQL, "бронирование фильма", movieID)
}

// ApplyBookingVerdict — воронка confirmed/failed.
func (r *Repository) ApplyBookingVerdict(ctx context.Context, _ string, confirmed bool) error {
	step := domain.StepFailed
	if confirmed {
		step = domain.StepConfirmed
	}
	return r.exec(ctx, incrFunnelSQL, "воронка "+string(step), step)
}

// Insights — витрина «Поведение»: воронка в порядке пути зрителя.
func (r *Repository) Insights(ctx context.Context) (domain.Insights, error) {
	var out domain.Insights

	funnel, err := r.listFunnel(ctx)
	if err != nil {
		return out, err
	}
	order := []domain.FunnelStep{
		domain.StepModalOpen, domain.StepSessionSelected, domain.StepSeatsSelected,
		domain.StepBookingCreated, domain.StepPaymentOpened, domain.StepPaid,
		domain.StepConfirmed, domain.StepFailed,
	}
	byStep := map[domain.FunnelStep]int64{}
	for _, row := range funnel {
		byStep[row.Step] = row.Count
	}
	for _, step := range order {
		if count := byStep[step]; count > 0 {
			out.Funnel = append(out.Funnel, domain.FunnelRow{Step: step, Count: count})
		}
	}

	if err := r.scan(ctx, listMoviesSQL, func(scan scanner) error {
		var m domain.MovieInterest
		if err := scan(&m.MovieID, &m.Opens, &m.Bookings); err != nil {
			return err
		}
		out.Movies = append(out.Movies, m)
		return nil
	}); err != nil {
		return out, fmt.Errorf("витрина фильмов: %w", err)
	}

	if err := r.scan(ctx, listPagesSQL, func(scan scanner) error {
		var p domain.PageStat
		if err := scan(&p.Route, &p.Views, &p.TotalMS); err != nil {
			return err
		}
		out.Pages = append(out.Pages, p)
		return nil
	}); err != nil {
		return out, fmt.Errorf("витрина страниц: %w", err)
	}

	if err := r.scan(ctx, listSeatsSQL, func(scan scanner) error {
		var h domain.SeatHeat
		if err := scan(&h.Hall, &h.Seat, &h.Clicks); err != nil {
			return err
		}
		out.Seats = append(out.Seats, h)
		return nil
	}); err != nil {
		return out, fmt.Errorf("витрина мест: %w", err)
	}

	if err := r.scan(ctx, listModalSQL, func(scan scanner) error {
		var st domain.ModalStat
		if err := scan(&st.Deepest, &st.Events, &st.TotalMS); err != nil {
			return err
		}
		out.Modal = append(out.Modal, st)
		return nil
	}); err != nil {
		return out, fmt.Errorf("витрина модалки: %w", err)
	}

	return out, nil
}

// Close закрывает пул; знает только composition root, не порт.
func (r *Repository) Close() error { return r.db.Close() }

type scanner func(dest ...any) error

func (r *Repository) exec(ctx context.Context, query, what string, args ...any) error {
	if _, err := r.db.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("%s: %w", what, err)
	}
	return nil
}

func (r *Repository) listFunnel(ctx context.Context) ([]domain.FunnelRow, error) {
	var rows []domain.FunnelRow
	err := r.scan(ctx, listFunnelSQL, func(scan scanner) error {
		var row domain.FunnelRow
		if err := scan(&row.Step, &row.Count); err != nil {
			return err
		}
		rows = append(rows, row)
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("витрина воронки: %w", err)
	}
	return rows, nil
}

func (r *Repository) scan(ctx context.Context, query string, row func(scan scanner) error) error {
	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		if err := row(rows.Scan); err != nil {
			return fmt.Errorf("чтение строки: %w", err)
		}
	}
	return rows.Err()
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

// Package postgres — Store-адаптер Курьера: таблица outbox_messages схемы
// cine — ОБЩАЯ база API, релей в ней гость. Схему создают миграции API
// (apps/api/src/migrations/1792886400000-AddOutbox.ts); релей её не строит
// и не меняет: если таблицы ещё нет (api стартует параллельно и не дошёл
// до миграций), тик честно логирует ошибку — следующий повторит, записи
// не теряются.
package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib" // регистрирует database/sql-драйвер "pgx" в init()

	"outbox-relay/internal/domain"
)

// Выборка батча: готовые к доставке, старшими вперёд. FOR UPDATE SKIP
// LOCKED в транзакции держит строки до пометки — параллельные тики (и
// реплики релея) не забирают и не дублируют чужое.
const batchSQL = `SELECT id, routing_key, payload, headers, attempts, created_at
	FROM outbox_messages
	WHERE published_at IS NULL AND next_attempt_at <= $1
	ORDER BY created_at, id
	LIMIT $2
	FOR UPDATE SKIP LOCKED`

const markPublishedSQL = `UPDATE outbox_messages
	SET published_at = $2, last_error = NULL
	WHERE id = $1 AND published_at IS NULL`

// Неудача: сдвиг попытки по бэкоффу; published_at не трогаем — запись
// остаётся в pending навсегда, пока не выйдет.
const markFailedSQL = `UPDATE outbox_messages
	SET attempts = $2, next_attempt_at = $3, last_error = $4
	WHERE id = $1 AND published_at IS NULL`

const statsSQL = `SELECT count(*), min(created_at)
	FROM outbox_messages
	WHERE published_at IS NULL`

type Repository struct {
	db         *sql.DB
	backoffCap time.Duration // кэп паузы между попытками (domain.NextDelay)
}

var _ domain.Store = (*Repository)(nil)

// NewRepository: DSN → пул → пинг. База уже существует (её создаёт стенд
// для API), схемы здесь нет — fail fast без живого PG: релей без хранилища
// бессмыслен, молчаливый no-op скрыл бы потерю доставки.
func NewRepository(ctx context.Context, dsn string, backoffCap time.Duration) (*Repository, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("парсинг DSN: %w", err)
	}
	if cfg.Database == "" {
		return nil, errors.New("в DSN нет имени базы")
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("открытие пула: %w", err)
	}
	// батч-транзакция + витрина Stats — двух подключений почти всегда
	// хватает, четвёртый страхует гонку тик/Notify
	db.SetMaxOpenConns(4)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("пинг Postgres, база %s (PG поднят? миграции API прошли?): %w", cfg.Database, err)
	}
	return &Repository{db: db, backoffCap: backoffCap}, nil
}

// DeliverBatch — вся доставка в одной транзакции: выборка с блокировкой,
// deliver-вердикт на каждую запись, пометки published/неудача, коммит.
// Краш до коммита откатывает пометки — строки вернутся следующим тиком
// (успевшее уйти в брокер может задвоиться; дубль гасится дедупом
// консьюмеров по amqp messageId = id записи).
func (r *Repository) DeliverBatch(ctx context.Context, limit int, deliver domain.DeliverFn) (int, error) {
	if limit < 1 {
		limit = 1
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("начало батч-транзакции: %w", err)
	}
	defer func() { _ = tx.Rollback() }() // после Commit — no-op

	rows, err := tx.QueryContext(ctx, batchSQL, time.Now(), limit)
	if err != nil {
		return 0, fmt.Errorf("выборка батча: %w", err)
	}
	msgs, err := scanMessages(rows)
	if err != nil {
		return 0, err
	}

	now := time.Now()
	for _, m := range msgs {
		var markErr error
		if err := deliver(ctx, m); err != nil {
			attempts := m.Attempts + 1
			retry := now.Add(domain.NextDelay(attempts, r.backoffCap))
			_, markErr = tx.ExecContext(ctx, markFailedSQL, m.ID, attempts, retry, errText(err))
		} else {
			_, markErr = tx.ExecContext(ctx, markPublishedSQL, m.ID, now)
		}
		if markErr != nil {
			// пометка не прошла — откат всего батча: недоставленное
			// вернётся, лучше дубль, чем потеря
			return len(msgs), fmt.Errorf("пометка записи %s: %w (батч откатится)", m.ID, markErr)
		}
	}

	if err := tx.Commit(); err != nil {
		return len(msgs), fmt.Errorf("коммит батча: %w", err)
	}
	return len(msgs), nil
}

// Stats — pending-хвост: сколько и старейшая почему ещё не ушла.
func (r *Repository) Stats(ctx context.Context) (domain.Stats, error) {
	var pending int64
	var oldest sql.NullTime
	if err := r.db.QueryRowContext(ctx, statsSQL).Scan(&pending, &oldest); err != nil {
		return domain.Stats{}, fmt.Errorf("чтение витрины: %w", err)
	}
	st := domain.Stats{Pending: pending}
	if oldest.Valid {
		st.OldestPending = oldest.Time
	}
	return st, nil
}

// Close закрывает пул; знает только composition root, не порт.
func (r *Repository) Close() error { return r.db.Close() }

// scanMessages вычитывает выбранный батч в память ДО пометок: по открытому
// Rows на соединении транзакции исполнять другие запросы нельзя.
func scanMessages(rows *sql.Rows) ([]domain.Message, error) {
	defer func() { _ = rows.Close() }()
	out := make([]domain.Message, 0)
	for rows.Next() {
		var m domain.Message
		var headers []byte
		if err := rows.Scan(&m.ID, &m.RoutingKey, &m.Payload, &headers,
			&m.Attempts, &m.CreatedAt); err != nil {
			return nil, fmt.Errorf("чтение строки outbox: %w", err)
		}
		m.Headers = map[string]string{}
		if len(headers) > 0 {
			if err := json.Unmarshal(headers, &m.Headers); err != nil {
				return nil, fmt.Errorf("заголовки записи %s: %w", m.ID, err)
			}
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("итерация батча: %w", err)
	}
	return out, nil
}

// errText режет текст ошибки для last_error: диагностика нужна, гигабайтные
// стеки broker down в таблице — нет.
func errText(err error) string {
	s := err.Error()
	if len(s) > 500 {
		return s[:500]
	}
	return s
}

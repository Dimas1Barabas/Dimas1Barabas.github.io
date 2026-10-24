// Package domain — сердце Курьера: запись outbox и порты, за которыми
// хранилище (таблица outbox_messages схемы cine) и брокер (exchange
// cinema). Схему создают миграции API — релей только читает и обновляет.
package domain

import (
	"context"
	"time"
)

// Message — запись outbox, ожидающая доставки в брокер.
type Message struct {
	ID         string            // uuid записи — станет amqp messageId (дедуп у консьюмеров)
	RoutingKey string            // ключ в exchange cinema
	Payload    []byte            // тело события, JSON
	Headers    map[string]string // amqp-заголовки: traceparent исходной операции
	Attempts   int               // сколько доставок не удалось (двигает бэкофф)
	CreatedAt  time.Time         // возраст записи — для витрины Stats
}

// DeliverFn — одна доставка внутри батча: nil — Store пометит published,
// ошибка — запишет неудачу (attempts+1, NextDelay, last_error).
type DeliverFn func(ctx context.Context, m Message) error

// Store — порт хранилища outbox.
type Store interface {
	// DeliverBatch в ОДНОЙ транзакции выбирает до limit готовых к доставке
	// записей (published_at IS NULL AND next_attempt_at <= now) с блокировкой
	// FOR UPDATE SKIP LOCKED — реплики релея не дерутся за одни записи, —
	// для каждой зовёт deliver и по её вердикту помечает published/неудачу.
	// Краш до коммита откатывает пометки: недоставленное вернётся следующим
	// тиком, а успевшее уйти может задвоиться — дубль гасит дедуп
	// консьюмеров по messageId.
	DeliverBatch(ctx context.Context, limit int, deliver DeliverFn) (int, error)
	// Stats — витрина: pending-хвост и возраст старейшей записи.
	Stats(ctx context.Context) (Stats, error)
}

// Stats — снимок состояния для gRPC/HTTP-витрины и метрик.
type Stats struct {
	Pending        int64     // записей ждёт доставки
	OldestPending  time.Time // created_at старейшей pending (zero — если пусто)
	PublishedTotal int64     // доставлено за жизнь процесса (рестарт обнуляет)
	FailedAttempts int64     // неудачных доставок (счётчик процесса)
}

// Publisher — порт доставки в брокер: exchange cinema; headers и
// messageId записи переносит amqp-адаптер.
type Publisher interface {
	Publish(ctx context.Context, m Message) error
}

// NextDelay — пауза до следующей попытки после attempts-й неудачи:
// экспонента от полсекунды (500мс, 1с, 2с, 4с…) с кэпом. Дропов нет —
// сбойный хвост держится в pending и долбится всё реже, но вечно.
func NextDelay(attempts int, cap time.Duration) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	d := 500 * time.Millisecond << (attempts - 1)
	if d <= 0 || d >= cap { // переполнение сдвигом или упёрлись в кэп
		return cap
	}
	return d
}

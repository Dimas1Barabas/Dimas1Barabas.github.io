package domain

import (
	"context"
	"errors"
	"time"
)

// ErrOrderNotFound — заказа нет в проекции (событие о чужом/стером
// заказе). Консьюмер отмены гасит его молча, кнопки витрины — 404.
var ErrOrderNotFound = errors.New("заказ не найден в очереди бара")

// Board — срез очереди для экрана бара: три активные колонки по
// порядку приёма и лента недавно закрытых (выдано/отменено).
type Board struct {
	New       []Order // ждут, пока Бармен возьмёт в работу
	Preparing []Order // на кухне
	Ready     []Order // ждут на стойке
	Recent    []Order // последние выданные/отменённые, новые сверху
}

// OrderStore — порт хранилища очереди (память или Postgres). События
// брокера — at-least-once: Upsert идемпотентен по OrderID и не
// перезаписывает прогресс (ределивери created не сбросит PREPARING).
type OrderStore interface {
	// Upsert принимает bar.order.created: нового — вставляет со
	// статусом NEW, существующего — оставляет как есть.
	Upsert(ctx context.Context, o Order) error
	// Get — заказ по id (ErrOrderNotFound, если проекция его не знает).
	Get(ctx context.Context, orderID string) (Order, error)
	// Save фиксирует переход: статус и ChangedAt.
	Save(ctx context.Context, o Order) error
	// Board — срез очереди для витрины.
	Board(ctx context.Context) (Board, error)
}

// StatusPublisher — исходящий порт: событие bar.order.status в обмен
// cinema. Читают NestJS API (обновление bar_orders) и
// notification-service («письмо» о готовности на READY).
type StatusPublisher interface {
	PublishStatus(ctx context.Context, o Order) error
}

// Clock — время переходов; интерфейс позволяет тестам его заморозить.
type Clock interface {
	Now() time.Time
}

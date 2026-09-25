package domain

import (
	"context"
)

// DemandStore — порт хранилища Тарификатора (память или Postgres):
// проекция занятости по сеансам + история проведённых квотов.
type DemandStore interface {
	// ApplyHeld применяет «места заняты» (бронь создана): +seats
	// к проекции сеанса. Дубль по (bookingID, held) — no-op,
	// redelivery события спрос не задваивает. false — дубль.
	ApplyHeld(ctx context.Context, sessionID, bookingID string, seats int) (bool, error)
	// ApplyReleased применяет «места свободны» (истёк резерв, отмена,
	// отказ платежа, возврат): −seats, но не ниже нуля.
	// Дубль по (bookingID, released) — no-op.
	ApplyReleased(ctx context.Context, sessionID, bookingID string, seats int) (bool, error)
	// Demand — занятые места сеанса по проекции (0 — событий не было).
	Demand(ctx context.Context, sessionID string) (int, error)
	// LogQuote записывает проведённый расчёт (витрина истории).
	LogQuote(ctx context.Context, sessionID string, q Quote) error
	// ListQuotes — витрина: свежие квоты сверху, ограничена 200.
	ListQuotes(ctx context.Context) ([]QuoteRecord, error)
	// ListDemand — витрина: проекция спроса по сеансам.
	ListDemand(ctx context.Context) ([]DemandRecord, error)
}

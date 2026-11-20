// Package domain — скоринг антифрода «Детектива»: чистые функции и
// типы без знания о транспортах и хранилищах.
package domain

import (
	"errors"
	"time"
)

// Facts — срез момента решения: чем дышит покупатель. Историю собирает
// API одним SQL-запросом и присылает факты по gRPC — Детектив правила
// знает, но в базу биллинга сам не ходит (как Привратник — синхронный).
type Facts struct {
	BookingID      string // идемпотентность: решение живёт под этим ключом
	UserID         string
	SessionID      string
	SeatsCount     int
	TotalRub       int // оценка чека на момент решения (места × цена)
	AccountAgeDays int // сколько дней счёту покупателя
	Bookings24h    int // броней за последние сутки (любых статусов)
	Cancels24h     int // отменённых и истёкших за сутки
	Failed24h      int // отказов оплаты за сутки
}

// Verdict — решение по брони: строка ездит в gRPC-контракте как есть.
type Verdict string

const (
	VerdictAllow  Verdict = "allow"  // покупать можно
	VerdictReview Verdict = "review" // бронь создаётся, оплата ждёт человека
	VerdictBlock  Verdict = "block"  // отказ — бронь не создаётся вовсе
)

// Status — жизненный цикл решения в витрине: автоматические вердикты
// закрываются сразу, review ждёт человека (approve/reject).
type Status string

const (
	StatusAutoAllowed   Status = "auto_allowed"
	StatusAutoBlocked   Status = "auto_blocked"
	StatusPendingReview Status = "pending_review"
	StatusApproved      Status = "approved"
	StatusRejected      Status = "rejected"
)

// ResolveAction — решение человека по брони из очереди ревью.
type ResolveAction string

const (
	ResolveApprove ResolveAction = "approve" // запустить оплату
	ResolveReject  ResolveAction = "reject"  // отменить бронь
)

// Ошибки жизненного цикла решения: отличимы вызывающему (gRPC-слой
// превращает их в NotFound/FailedPrecondition, API — в 404/409).
var (
	ErrUnknownResolveAction = errors.New("неизвестное действие решения")
	ErrDecisionNotFound     = errors.New("решение не найдено")
	ErrAlreadyResolved      = errors.New("решение уже закрыто")
)

// Decision — вердикт и его объяснение: скор, коды сработавших правил
// и сам срез фактов (витрина показывает, что именно насторожило).
type Decision struct {
	Facts   Facts
	Score   int
	Verdict Verdict
	Reasons []string
}

// DecisionRecord — строка витрины: решение и его жизненный цикл.
type DecisionRecord struct {
	Decision
	Status     Status
	ResolvedBy string    // email админа; пусто, пока ждёт человека
	ResolvedAt time.Time // zero, пока ждёт человека
	CreatedAt  time.Time
}

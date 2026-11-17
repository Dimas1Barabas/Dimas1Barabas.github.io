// Package domain — суть Бармена: очередь заказов кинобара и её
// жизненный цикл. Транзишены — методы заказа: неверный шаг невозможен
// без визуального «взлома» типов, use-cases лишь зовут их.
package domain

import (
	"errors"
	"strconv"
	"time"
)

// Status — статусы проекции заказа. NEW/PREPARING/READY/PICKED_UP
// публикуются в cinema (bar.order.status), CANCELLED — локальная
// пометка «убрать с доски»: отмена инициирует API владельца, Бармен
// только перестаёт готовить.
type Status string

const (
	StatusNew       Status = "NEW"
	StatusPreparing Status = "PREPARING"
	StatusReady     Status = "READY"
	StatusPickedUp  Status = "PICKED_UP"
	StatusCancelled Status = "CANCELLED"
)

// Item — позиция заказа со снимком цены (каталог в API, Бармену нужен
// только состав для экрана бара).
type Item struct {
	ItemID   string `json:"itemId"`
	Name     string `json:"name"`
	PriceRub int    `json:"priceRub"`
	Qty      int    `json:"qty"`
}

// Order — проекция bar.order.created в базе Бармена: всё, что нужно
// экрану бара и событию bar.order.status.
type Order struct {
	OrderID      string
	UserID       string
	Email        string    // адресат «письма» о готовности (шлёт notification-service)
	CustomerName string    // «для кого» на экране бара
	SessionID    string    // "" — заказ без сеанса
	SessionAt    time.Time // zero — заказ без сеанса
	Hall         string
	Items        []Item
	TotalRub     int
	Status       Status
	CreatedAt    time.Time
	ChangedAt    time.Time
}

// ErrInvalidTransition — переход не по циклу (готовить выданное и т.п.)
var ErrInvalidTransition = errors.New("недопустимый переход статуса заказа")

// Summary — состав заказа одной строкой для логов и экрана бара:
// «Попкорн солёный×2, Кола 0,5 л×1 — 860 ₽».
func (o Order) Summary() string {
	s := ""
	for i, it := range o.Items {
		if i > 0 {
			s += ", "
		}
		s += it.Name + "×" + strconv.Itoa(it.Qty)
	}
	return s + " — " + strconv.Itoa(o.TotalRub) + " ₽"
}

// SessionLabel — подсказка «выдать к сеансу»: «IMAX, Thu 19:30» или
// «без сеанса» (забрать на стойке в любое время).
func (o Order) SessionLabel() string {
	if o.SessionID == "" || o.SessionAt.IsZero() {
		return "без сеанса"
	}
	return o.Hall + ", " + o.SessionAt.Format("Mon 15:04")
}

// Start — «взять в работу»: NEW → PREPARING.
func (o *Order) Start() error {
	if o.Status != StatusNew {
		return ErrInvalidTransition
	}
	o.Status = StatusPreparing
	return nil
}

// Ready — «попкорн готов»: PREPARING → READY.
func (o *Order) Ready() error {
	if o.Status != StatusPreparing {
		return ErrInvalidTransition
	}
	o.Status = StatusReady
	return nil
}

// PickUp — «выдан гостю»: READY → PICKED_UP.
func (o *Order) PickUp() error {
	if o.Status != StatusReady {
		return ErrInvalidTransition
	}
	o.Status = StatusPickedUp
	return nil
}

// Cancel — «владелец передумал»: NEW/PREPARING → CANCELLED. Повторная
// отмена (ределивери bar.order.cancelled) — не ошибка: заказ уже снят.
func (o *Order) Cancel() error {
	switch o.Status {
	case StatusNew, StatusPreparing:
		o.Status = StatusCancelled
		return nil
	case StatusCancelled:
		return nil // идемпотентно: дубль события молча гасится
	default:
		// READY/PICKED_UP отменить нельзя — API не шлёт таких отмен,
		// но защитимся от рассинхрона статусов
		return ErrInvalidTransition
	}
}

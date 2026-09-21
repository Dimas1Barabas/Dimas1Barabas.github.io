// Package domain — сердце гексагона: агрегат «уведомление», входной
// вердикт Outcome и фабрика. Домен ничего не знает ни о RabbitMQ,
// ни о HTTP, ни о хранилище — зависимости идут только внутрь.
package domain

import (
	"errors"
	"fmt"
	"time"
)

// Kind — тип уведомления, определяется вердиктом брони.
type Kind string

const (
	KindConfirmed     Kind = "booking_confirmed"
	KindFailed        Kind = "booking_failed"
	KindRefunded      Kind = "booking_refunded"
	KindRefundFailed  Kind = "refund_failed"
	KindExpired       Kind = "booking_expired"
	KindPasswordReset Kind = "password_reset"
	KindWaitlistSeat  Kind = "waitlist_seat"
)

// DeliveryStatus — судьба отправки.
type DeliveryStatus string

const (
	StatusSent   DeliveryStatus = "SENT"
	StatusFailed DeliveryStatus = "FAILED"
)

// ErrUnknownVerdict — вердикт не входит в известный набор: сообщение
// ядовитое, брокерный адаптер обязан увести его в parking.
var ErrUnknownVerdict = errors.New("неизвестный вердикт")

// Outcome — вердикт события (booking.processed / booking.refunded /
// booking.expired), приведённый брокерным адаптером к языку домена.
type Outcome struct {
	BookingID   string
	Verdict     string // CONFIRMED | FAILED | CANCELLED | REFUND_FAILED | EXPIRED
	Message     string
	ProcessedBy string
}

// Notification — одно клиентское уведомление по брони.
type Notification struct {
	ID        string         `json:"id"`
	BookingID string         `json:"bookingId"`
	Kind      Kind           `json:"kind"`
	Title     string         `json:"title"`
	Body      string         `json:"body"`
	Channel   string         `json:"channel"` // email
	Status    DeliveryStatus `json:"status"`
	Error     string         `json:"error,omitempty"`
	CreatedAt time.Time      `json:"createdAt"`
}

// NewFromOutcome строит уведомление из вердикта. Тексты — решение домена:
// клиентские формулировки живут здесь, а не в адаптере доставки.
func NewFromOutcome(o Outcome, now time.Time) (Notification, error) {
	var kind Kind
	var title string
	switch o.Verdict {
	case "CONFIRMED":
		kind, title = KindConfirmed, "Бронь подтверждена"
	case "FAILED":
		kind, title = KindFailed, "Платёж не прошёл"
	case "CANCELLED":
		kind, title = KindRefunded, "Возврат зачислен"
	case "REFUND_FAILED":
		kind, title = KindRefundFailed, "Возврат не удался"
	case "EXPIRED":
		kind, title = KindExpired, "Время оплаты истекло"
	case "PASSWORD_RESET":
		kind, title = KindPasswordReset, "Сброс пароля"
	case "WAITLIST_SEAT":
		kind, title = KindWaitlistSeat, "Место освободилось"
	default:
		return Notification{}, fmt.Errorf("%w: %q", ErrUnknownVerdict, o.Verdict)
	}
	return Notification{
		// timestamp гарантирует уникальность в рамках брони: вердикты
		// одного bookingId приходят с разницей минимум в секунды
		ID:        now.UTC().Format("20060102T150405.000000000") + "-" + o.BookingID,
		BookingID: o.BookingID,
		Kind:      kind,
		Title:     title,
		Body:      o.Message,
		Channel:   "email",
		Status:    StatusSent, // use-case переведёт в FAILED, если шлюз упал
		CreatedAt: now,
	}, nil
}

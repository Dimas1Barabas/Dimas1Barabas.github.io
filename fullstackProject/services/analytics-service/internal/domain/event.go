// Package domain — событие поведения и агрегаты Аналитика: чистые типы
// без знания о брокере, HTTP и хранилище.
package domain

import "errors"

// EventType — тип события поведения с веба. Совпадает с закрытым
// набором на стороне API (apps/api/src/analytics/analytics-events.ts):
// рассинхрон ловится валидацией — неизвестный тип едет в parking.
type EventType string

const (
	EventPageView         EventType = "page_view"
	EventPageDwell        EventType = "page_dwell"
	EventBookingModalOpen EventType = "booking_modal_open"
	EventSessionSelected  EventType = "session_selected"
	EventSeatsSelected    EventType = "seats_selected"
	EventSeatClick        EventType = "seat_click"
	EventBookingCreated   EventType = "booking_created"
	EventPaymentOpened    EventType = "payment_opened"
	EventModalDwell       EventType = "modal_dwell"
)

// Event — расшифрованное событие поведения: тип + разреженные поля
// по смыслу. Идентичность (aid/userId) входит в конверт события —
// API штампует её при инжесте батча.
type Event struct {
	AID       string    // anon id посетителя (localStorage на вебе)
	UserID    string    // непусто, если событие под аккаунтом
	Type      EventType
	Route     string // page_*: маршрут роутера
	MS        int64  // page_dwell/modal_dwell: активные миллисекунды
	Deepest   string // modal_dwell: session | seats | created
	MovieID   string
	SessionID string
	Seat      string // «ряд-место», например 5-7
	Hall      string
	Count     int64 // seats_selected: сколько мест выбрано
	BookingID string // booking_created/payment_opened: бронь пути
}

// ErrInvalidEvent — событие не проходит инварианты: конфигурационная
// ошибка публикатора, ретраи бессмысленны (poison → parking).
var ErrInvalidEvent = errors.New("битое событие аналитики")

// FunnelStep — шаг воронки пути зрителя. Первые шесть рисует веб
// (интерес и намерение), последние три — транзакционная сторона
// из событий брокера (booking.created/booking.processed).
type FunnelStep string

const (
	StepModalOpen       FunnelStep = "modal_open"
	StepSessionSelected FunnelStep = "session_selected"
	StepSeatsSelected   FunnelStep = "seats_selected"
	StepBookingCreated  FunnelStep = "booking_created"
	StepPaymentOpened   FunnelStep = "payment_opened"
	StepPaid            FunnelStep = "paid"
	StepConfirmed       FunnelStep = "confirmed"
	StepFailed          FunnelStep = "failed"
)

// FunnelStepOf сопоставляет событию веба шаг воронки; пусто — событие
// в воронку не входит (клики по местам, времена пребывания — отдельно).
var FunnelStepOf = map[EventType]FunnelStep{
	EventBookingModalOpen: StepModalOpen,
	EventSessionSelected:  StepSessionSelected,
	EventSeatsSelected:    StepSeatsSelected,
	EventBookingCreated:   StepBookingCreated,
	EventPaymentOpened:    StepPaymentOpened,
}

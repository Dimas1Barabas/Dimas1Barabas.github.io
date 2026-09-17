// Package events описывает контракты событий topic-обмена «cinema» —
// общие для NestJS API и Go-воркера. Поля меняем только согласованно:
// сериализация в JSON является межсервисным протоколом.
package events

import "time"

// Routing keys обмена «cinema».
const (
	KeyCreated        = "booking.created"         // API → воркер: провести оплату
	KeyProcessed      = "booking.processed"       // воркер → API: вердикт оплаты
	KeyCancelled      = "booking.cancelled"       // API → воркер: вернуть платёж (сага отмены)
	KeyRefunded       = "booking.refunded"        // воркер → API: вердикт возврата
	KeyPaymentTimeout = "booking.payment.timeout" // wait-очередь API → воркер: резерв истёк (dead-letter)
	KeyExpired        = "booking.expired"         // воркер → API: вердикт истечения
)

// BookingCreated — событие от API: booking.created.
type BookingCreated struct {
	BookingID    string    `json:"bookingId"`
	MovieID      string    `json:"movieId"`
	MovieTitle   string    `json:"movieTitle"`
	CustomerName string    `json:"customerName"`
	Seats        []string  `json:"seats"` // коды «ряд-место», например "5-7"
	TotalRub     int       `json:"totalRub"`
	CreatedAt    time.Time `json:"createdAt"`
}

// BookingProcessed — ответ воркера: booking.processed.
type BookingProcessed struct {
	BookingID   string `json:"bookingId"`
	Status      string `json:"status"` // CONFIRMED | FAILED
	Message     string `json:"message"`
	ProcessedBy string `json:"processedBy"`
	ProcessedAt string `json:"processedAt"`
}

// BookingCancelled — событие от API: booking.cancelled (запрос возврата).
type BookingCancelled struct {
	BookingID    string    `json:"bookingId"`
	MovieID      string    `json:"movieId"`
	MovieTitle   string    `json:"movieTitle"`
	CustomerName string    `json:"customerName"`
	Seats        []string  `json:"seats"`
	TotalRub     int       `json:"totalRub"`
	CancelledAt  time.Time `json:"cancelledAt"`
}

// BookingRefunded — ответ воркера: booking.refunded.
type BookingRefunded struct {
	BookingID   string `json:"bookingId"`
	Status      string `json:"status"` // CANCELLED | REFUND_FAILED
	Message     string `json:"message"`
	ProcessedBy string `json:"processedBy"`
	ProcessedAt string `json:"processedAt"`
}

// BookingPaymentTimeout — сообщение из wait-очереди API: TTL окна оплаты
// истёк, бронь не оплачена. Воркеру нужен только bookingId; totalRub и
// expiresAt (их шлёт API) игнорируются — как sessionId/hall в других.
type BookingPaymentTimeout struct {
	BookingID string `json:"bookingId"`
}

// BookingExpired — ответ воркера: booking.expired.
type BookingExpired struct {
	BookingID   string `json:"bookingId"`
	Message     string `json:"message"`
	ProcessedBy string `json:"processedBy"`
	ExpiredAt   string `json:"expiredAt"`
}

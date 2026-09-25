package amqp

import (
	"encoding/json"
	"fmt"

	amqp091 "github.com/rabbitmq/amqp091-go"
)

// demandChange — расшифрованное событие: сколько мест и куда.
// Тип взаимодействия определяет routing key.
type demandChange struct {
	held      bool
	sessionID string
	bookingID string
	seats     int
}

// toDemandChange приводит доставку к изменению спроса. Оба события
// публикует NestJS API: у брони — sessionId и число мест, у освобождения —
// sessionId и список мест (счёт = длина).
func toDemandChange(d amqp091.Delivery) (demandChange, error) {
	switch d.RoutingKey {
	case keySeatsHeld:
		var p heldPayload
		if err := json.Unmarshal(d.Body, &p); err != nil {
			return demandChange{}, fmt.Errorf("не разбирается JSON: %w", err)
		}
		if p.SessionID == "" || p.BookingID == "" {
			return demandChange{}, fmt.Errorf("%s без sessionId/bookingId — спрос не провести", keySeatsHeld)
		}
		if p.SeatsCount <= 0 {
			return demandChange{}, fmt.Errorf("%s с неположительным числом мест (%d)", keySeatsHeld, p.SeatsCount)
		}
		return demandChange{held: true, sessionID: p.SessionID, bookingID: p.BookingID, seats: p.SeatsCount}, nil
	case keySeatsRelease:
		var p releasedPayload
		if err := json.Unmarshal(d.Body, &p); err != nil {
			return demandChange{}, fmt.Errorf("не разбирается JSON: %w", err)
		}
		if p.SessionID == "" || p.BookingID == "" {
			return demandChange{}, fmt.Errorf("%s без sessionId/bookingId — спрос не провести", keySeatsRelease)
		}
		if len(p.Seats) == 0 {
			return demandChange{}, fmt.Errorf("%s без мест — спрос не провести", keySeatsRelease)
		}
		return demandChange{held: false, sessionID: p.SessionID, bookingID: p.BookingID, seats: len(p.Seats)}, nil
	default:
		return demandChange{}, fmt.Errorf("неизвестный routing key %q", d.RoutingKey)
	}
}

// heldPayload — событие booking.payment.wait: бронь создана, места
// в резерве (включая ждущие оплаты — их видит и карта занятости).
type heldPayload struct {
	BookingID  string `json:"bookingId"`
	SessionID  string `json:"sessionId"`
	SeatsCount int    `json:"seatsCount"`
	TotalRub   int    `json:"totalRub"`
	ExpiresAt  string `json:"expiresAt"`
}

// releasedPayload — событие waitlist.seat.released: места снова
// в продаже. Причина (reason) производна статусу брони, спросу всё равно.
type releasedPayload struct {
	BookingID string   `json:"bookingId"`
	SessionID string   `json:"sessionId"`
	Seats     []string `json:"seats"`
	Reason    string   `json:"reason"`
}

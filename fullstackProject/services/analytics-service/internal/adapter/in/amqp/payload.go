package amqp

import (
	"encoding/json"
	"fmt"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"analytics-service/internal/domain"
)

// ingestPayload — событие поведения из инжеста API (штамп конверта
// батча API уже вшил в каждое сообщение). Поля — как в analytics-events.ts.
type ingestPayload struct {
	AID       string `json:"aid"`
	UserID    string `json:"userId"`
	Type      string `json:"type"`
	TS        string `json:"ts"`
	Route     string `json:"route"`
	MS        int64  `json:"ms"`
	Deepest   string `json:"deepest"`
	MovieID   string `json:"movieId"`
	SessionID string `json:"sessionId"`
	Seat      string `json:"seat"`
	Hall      string `json:"hall"`
	Count     int64  `json:"count"`
	BookingID string `json:"bookingId"`
}

// bookingCreatedPayload — booking.created от API (после оплаты):
// воронка paid + конверсия фильма. Тот же контракт, что читает воркер.
type bookingCreatedPayload struct {
	BookingID string `json:"bookingId"`
	MovieID   string `json:"movieId"`
	CreatedAt string `json:"createdAt"`
}

// bookingProcessedPayload — booking.processed от Go-воркера:
// вердикт закрывает воронку.
type bookingProcessedPayload struct {
	BookingID string `json:"bookingId"`
	Status    string `json:"status"` // CONFIRMED | FAILED
}

// kind — какой поток родил сообщение; различает routing key.
type kind int

const (
	kindWeb kind = iota // analytics.event
	kindPaid            // booking.created
	kindVerdict         // booking.processed
)

// decoded — команда для анализатора: ровно одно поле каждой ветки
// валидно (event при kindWeb, booking/movie при kindPaid, confirmed
// при kindVerdict).
type decoded struct {
	kind      kind
	event     domain.Event
	bookingID string
	movieID   string
	confirmed bool
}

func decode(d amqp091.Delivery) (decoded, error) {
	switch d.RoutingKey {
	case keyAnalyticsEvent:
		var p ingestPayload
		if err := json.Unmarshal(d.Body, &p); err != nil {
			return decoded{}, fmt.Errorf("не разбирается JSON: %w", err)
		}
		if p.TS != "" {
			if _, err := time.Parse(time.RFC3339, p.TS); err != nil {
				return decoded{}, fmt.Errorf("ts не RFC3339: %w", err)
			}
		}
		return decoded{kind: kindWeb, event: domain.Event{
			AID:       p.AID,
			UserID:    p.UserID,
			Type:      domain.EventType(p.Type),
			Route:     p.Route,
			MS:        p.MS,
			Deepest:   p.Deepest,
			MovieID:   p.MovieID,
			SessionID: p.SessionID,
			Seat:      p.Seat,
			Hall:      p.Hall,
			Count:     p.Count,
			BookingID: p.BookingID,
		}}, nil

	case keyBookingCreated:
		var p bookingCreatedPayload
		if err := json.Unmarshal(d.Body, &p); err != nil {
			return decoded{}, fmt.Errorf("не разбирается JSON: %w", err)
		}
		return decoded{kind: kindPaid, bookingID: p.BookingID, movieID: p.MovieID}, nil

	case keyBookingProcessed:
		var p bookingProcessedPayload
		if err := json.Unmarshal(d.Body, &p); err != nil {
			return decoded{}, fmt.Errorf("не разбирается JSON: %w", err)
		}
		if p.Status != "CONFIRMED" && p.Status != "FAILED" {
			return decoded{}, fmt.Errorf("booking.processed с неожиданным статусом %q", p.Status)
		}
		return decoded{kind: kindVerdict, bookingID: p.BookingID, confirmed: p.Status == "CONFIRMED"}, nil

	default:
		return decoded{}, fmt.Errorf("неизвестный routing key %q", d.RoutingKey)
	}
}

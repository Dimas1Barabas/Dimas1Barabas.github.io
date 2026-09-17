package amqp

import (
	"encoding/json"
	"fmt"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"notification-service/internal/domain"
)

// toOutcome приводит доставку к доменному вердикту. У событий оплаты и
// возврата вердикт лежит в поле status, у истечения поля статуса нет —
// сам routing key означает EXPIRED.
func toOutcome(d amqp091.Delivery) (domain.Outcome, error) {
	var p verdictPayload
	if err := json.Unmarshal(d.Body, &p); err != nil {
		return domain.Outcome{}, fmt.Errorf("не разбирается JSON: %w", err)
	}
	o := domain.Outcome{
		BookingID:   p.BookingID,
		Message:     p.Message,
		ProcessedBy: p.ProcessedBy,
	}
	switch d.RoutingKey {
	case keyProcessed, keyRefunded:
		o.Verdict = p.Status
	case keyExpired:
		o.Verdict = "EXPIRED"
	default:
		return domain.Outcome{}, fmt.Errorf("неизвестный routing key %q", d.RoutingKey)
	}
	return o, nil
}

// verdictPayload — общая форма вердиктов воркера: во всех трёх событиях
// поля названы одинаково, различается лишь набор статусов.
type verdictPayload struct {
	BookingID   string `json:"bookingId"`
	Status      string `json:"status"` // processed | refunded
	Message     string `json:"message"`
	ProcessedBy string `json:"processedBy"`
}

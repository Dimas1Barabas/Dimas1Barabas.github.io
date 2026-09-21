package amqp

import (
	"encoding/json"
	"fmt"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"notification-service/internal/domain"
)

// toOutcome приводит доставку к доменному вердикту. У событий оплаты и
// возврата вердикт лежит в поле status, у истечения поля статуса нет —
// сам routing key означает EXPIRED. Письмо сброса пароля приходит от
// NestJS API: адресат — в поле email, ссылка — в message.
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
	case keyPasswordReset:
		if p.Email == "" {
			return domain.Outcome{}, fmt.Errorf("password.reset без адресата (email)")
		}
		o.Verdict = "PASSWORD_RESET"
		// адресат едет в BookingID: поле — «ссылка на сущность», для сброса
		// пароля это email; хранилища и фильтр /notifications не меняются
		o.BookingID = p.Email
	case keyWaitlistSeat:
		if p.Email == "" {
			return domain.Outcome{}, fmt.Errorf("waitlist.seat без адресата (email)")
		}
		o.Verdict = "WAITLIST_SEAT"
		// тот же приём: адресат письма — email из BookingID
		o.BookingID = p.Email
	default:
		return domain.Outcome{}, fmt.Errorf("неизвестный routing key %q", d.RoutingKey)
	}
	return o, nil
}

// verdictPayload — общая форма событий: у вердиктов воркера поля названы
// одинаково, письмо сброса добавляет email адресата.
type verdictPayload struct {
	BookingID   string `json:"bookingId"`
	Status      string `json:"status"` // processed | refunded
	Message     string `json:"message"`
	ProcessedBy string `json:"processedBy"`
	Email       string `json:"email,omitempty"` // user.password.reset от NestJS
}

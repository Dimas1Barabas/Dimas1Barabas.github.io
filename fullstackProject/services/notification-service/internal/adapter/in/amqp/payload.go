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
		// messageId публикации: Курьер кладёт uuid outbox-записи — по нему
		// хранилище гасит дубль ределивери; пусто у вердиктов воркера
		MessageID: d.MessageId,
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
	case keySessionReminder:
		if p.Email == "" {
			return domain.Outcome{}, fmt.Errorf("session.reminder без адресата (email)")
		}
		o.Verdict = "SESSION_REMINDER"
		// и здесь адресат едет в BookingID; текст письма прислал сервис
		o.BookingID = p.Email
	case keyBarReady:
		if p.Email == "" {
			return domain.Outcome{}, fmt.Errorf("bar.order.ready без адресата (email)")
		}
		if p.OrderID == "" {
			return domain.Outcome{}, fmt.Errorf("bar.order.ready без orderId")
		}
		o.Verdict = "BAR_READY"
		// текст собираем из полей события: Бармен шлёт контракт без message
		who := p.CustomerName
		if who == "" {
			who = "Ваш"
		} else {
			who += ", ваш"
		}
		o.Message = fmt.Sprintf("%s заказ кинобара готов — ждём на стойке бара (заказ %s)",
			who, shortID(p.OrderID))
		// тот же приём: адресат письма — email из BookingID
		o.BookingID = p.Email
	default:
		return domain.Outcome{}, fmt.Errorf("неизвестный routing key %q", d.RoutingKey)
	}
	return o, nil
}

// shortID — человекочитаемый хвост uuid-заказа для текста письма.
func shortID(id string) string {
	if len(id) > 8 {
		return "№" + id[:8]
	}
	return "№" + id
}

// verdictPayload — общая форма событий: у вердиктов воркера поля названы
// одинаково, письма сброса/листа/сеанса добавляют email адресата,
// готовность кинобара — orderId и имя гостя.
type verdictPayload struct {
	BookingID    string `json:"bookingId"`
	Status       string `json:"status"` // processed | refunded
	Message      string `json:"message"`
	ProcessedBy  string `json:"processedBy"`
	Email        string `json:"email,omitempty"`        // user.password.reset от NestJS
	OrderID      string `json:"orderId,omitempty"`      // bar.order.ready от Бармена
	CustomerName string `json:"customerName,omitempty"` // bar.order.ready от Бармена
}

package amqp

import (
	"testing"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"
)

func delivery(rk, body string) amqp091.Delivery {
	return amqp091.Delivery{RoutingKey: rk, Body: []byte(body)}
}

// Приём заказа: все поля переживают JSON, сеанс распаковывается.
func TestParseCreated(t *testing.T) {
	o, cancelID, err := parseDelivery(delivery(keyCreated, `{
		"orderId": "o-1",
		"userId": "u-1",
		"customerName": "Анна",
		"email": "anna@test.local",
		"sessionId": "s-1",
		"sessionAt": "2026-11-20T19:30:00Z",
		"hall": "IMAX",
		"items": [
			{"itemId": "i-1", "name": "Попкорн солёный", "priceRub": 320, "qty": 2}
		],
		"totalRub": 640,
		"createdAt": "2026-11-17T12:00:00Z"
	}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cancelID != "" {
		t.Fatalf("created не несёт cancelID")
	}
	if o == nil || o.OrderID != "o-1" || o.Email != "anna@test.local" {
		t.Fatalf("заказ: %+v", o)
	}
	if len(o.Items) != 1 || o.Items[0].Qty != 2 {
		t.Fatalf("позиции: %+v", o.Items)
	}
	want, _ := time.Parse(time.RFC3339, "2026-11-20T19:30:00Z")
	if !o.SessionAt.Equal(want) {
		t.Fatalf("sessionAt: %v, ожидалась %v", o.SessionAt, want)
	}
}

// Заказ без сеанса: sessionId пуст, sessionAt — zero time.
func TestParseCreatedWithoutSession(t *testing.T) {
	o, _, err := parseDelivery(delivery(keyCreated, `{
		"orderId": "o-2",
		"userId": "u-2",
		"customerName": "Борис",
		"email": "boris@test.local",
		"items": [{"itemId": "i-2", "name": "Кола 0,5 л", "priceRub": 220, "qty": 1}],
		"totalRub": 220,
		"createdAt": "2026-11-17T12:05:00Z"
	}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if o == nil || o.SessionID != "" || !o.SessionAt.IsZero() {
		t.Fatalf("заказ без сеанса: %+v", o)
	}
}

func TestParseCancelled(t *testing.T) {
	_, cancelID, err := parseDelivery(delivery(keyCancelled,
		`{"orderId": "o-1", "cancelledAt": "2026-11-17T12:10:00Z"}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cancelID != "o-1" {
		t.Fatalf("cancelID: %q", cancelID)
	}
}

// Битые события — poison, а не транзиентный сбой: пустой orderId,
// пустой состав, сломанный JSON, неизвестный routing key, кривое время.
func TestParsePoison(t *testing.T) {
	cases := map[string]amqp091.Delivery{
		"битый JSON":          delivery(keyCreated, `{`),
		"created без id":      delivery(keyCreated, `{"items": [{"itemId":"i","name":"n","qty":1}]}`),
		"created без позиций": delivery(keyCreated, `{"orderId": "o-3"}`),
		"cancelled без id":    delivery(keyCancelled, `{"cancelledAt": "2026-11-17T12:10:00Z"}`),
		"кривое sessionAt":    delivery(keyCreated, `{"orderId": "o-4", "items": [{"itemId":"i","name":"n","qty":1}], "sessionAt": "срочно"}`),
		"неизвестный rk":      delivery("bar.order.mystery", `{}`),
	}
	for name, d := range cases {
		if _, _, err := parseDelivery(d); err == nil {
			t.Fatalf("%s: ожидалась ошибка poison", name)
		}
	}
}

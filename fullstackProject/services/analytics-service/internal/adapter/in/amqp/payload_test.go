package amqp

import (
	"testing"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"analytics-service/internal/domain"
)

func delivery(routingKey string, body string) amqp091.Delivery {
	return amqp091.Delivery{
		RoutingKey:    routingKey,
		ContentType:   "application/json",
		Body:          []byte(body),
		DeliveryMode:  amqp091.Persistent,
	}
}

func TestDecodeWebEvent(t *testing.T) {
	d, err := decode(delivery(keyAnalyticsEvent, `{
		"aid": "11111111-1111-4111-8111-111111111111",
		"userId": "22222222-2222-4222-8222-222222222222",
		"type": "seat_click",
		"ts": "2026-10-12T10:00:05.000Z",
		"sessionId": "s-1",
		"seat": "5-7",
		"hall": "Красный"
	}`))
	if err != nil {
		t.Fatalf("декод: %v", err)
	}
	if d.kind != kindWeb || d.event.Type != domain.EventSeatClick {
		t.Fatalf("ожидали web seat_click: %+v", d)
	}
	if d.event.AID == "" || d.event.Hall != "Красный" || d.event.Seat != "5-7" {
		t.Fatalf("поля потерялись: %+v", d.event)
	}
}

func TestDecodeBookingCreated(t *testing.T) {
	d, err := decode(delivery(keyBookingCreated, `{"bookingId":"b-1","movieId":"m-1","createdAt":"2026-10-12T10:00:00Z"}`))
	if err != nil {
		t.Fatalf("декод: %v", err)
	}
	if d.kind != kindPaid || d.bookingID != "b-1" || d.movieID != "m-1" {
		t.Fatalf("ожидали paid b-1/m-1: %+v", d)
	}
}

func TestDecodeVerdict(t *testing.T) {
	d, err := decode(delivery(keyBookingProcessed, `{"bookingId":"b-1","status":"CONFIRMED","message":"","processedBy":"go-worker-1","processedAt":"2026-10-12T10:00:01Z"}`))
	if err != nil {
		t.Fatalf("декод: %v", err)
	}
	if d.kind != kindVerdict || !d.confirmed {
		t.Fatalf("ожидали confirmed: %+v", d)
	}
}

func TestDecodePoison(t *testing.T) {
	cases := []struct {
		name string
		key  string
		body string
	}{
		{"битый JSON", keyAnalyticsEvent, `{"aid": `},
		{"ts не RFC3339", keyAnalyticsEvent, `{"aid":"a","type":"page_view","ts":"12.10.2026"}`},
		{"неожиданный статус", keyBookingProcessed, `{"bookingId":"b-1","status":"PENDING"}`},
		{"неизвестный rk", "reviews.created", `{"x":1}`},
	}
	for _, c := range cases {
		if _, err := decode(delivery(c.key, c.body)); err == nil {
			t.Fatalf("%s: ожидали ошибку декода", c.name)
		}
	}
}

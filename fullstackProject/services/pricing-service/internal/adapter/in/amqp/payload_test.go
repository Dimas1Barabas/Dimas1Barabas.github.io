package amqp

import (
	"testing"

	amqp091 "github.com/rabbitmq/amqp091-go"
)

func delivery(rk, body string) amqp091.Delivery {
	return amqp091.Delivery{RoutingKey: rk, Body: []byte(body)}
}

func TestHeldPayload(t *testing.T) {
	change, err := toDemandChange(delivery(keySeatsHeld,
		`{"bookingId":"b-1","sessionId":"s-1","seatsCount":3,"totalRub":1200,"expiresAt":"2026-09-25T10:00:00Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !change.held || change.sessionID != "s-1" || change.bookingID != "b-1" || change.seats != 3 {
		t.Fatalf("change = %+v", change)
	}
}

func TestReleasedPayload(t *testing.T) {
	change, err := toDemandChange(delivery(keySeatsRelease,
		`{"bookingId":"b-1","sessionId":"s-1","seats":["5-7","5-8"],"reason":"EXPIRED","releasedAt":"2026-09-25T10:00:00Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	if change.held || change.sessionID != "s-1" || change.bookingID != "b-1" || change.seats != 2 {
		t.Fatalf("change = %+v", change)
	}
}

func TestPoisonPayloads(t *testing.T) {
	cases := []struct {
		name string
		rk   string
		body string
	}{
		{"битый JSON", keySeatsHeld, `{bookingId:`},
		{"неизвестный rk", "booking.unknown", `{"bookingId":"b-1"}`},
		{"held без sessionId", keySeatsHeld, `{"bookingId":"b-1","seatsCount":2}`},
		{"held без bookingId", keySeatsHeld, `{"sessionId":"s-1","seatsCount":2}`},
		{"held с нулём мест", keySeatsHeld, `{"bookingId":"b-1","sessionId":"s-1","seatsCount":0}`},
		{"released без мест", keySeatsRelease, `{"bookingId":"b-1","sessionId":"s-1","seats":[]}`},
		{"released без sessionId", keySeatsRelease, `{"bookingId":"b-1","seats":["5-7"]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := toDemandChange(delivery(tc.rk, tc.body)); err == nil {
				t.Fatal("ожидался отказ poison-ветки")
			}
		})
	}
}

// поля события оплаты, которые Тарификатору не нужны, — молча
// игнорируются (контракт API может расширяться)
func TestExtraFieldsIgnored(t *testing.T) {
	change, err := toDemandChange(delivery(keySeatsHeld,
		`{"bookingId":"b-1","sessionId":"s-1","seatsCount":2,"customerName":"Дмитрий"}`))
	if err != nil {
		t.Fatal(err)
	}
	if change.seats != 2 {
		t.Fatalf("seats = %d, want 2", change.seats)
	}
}

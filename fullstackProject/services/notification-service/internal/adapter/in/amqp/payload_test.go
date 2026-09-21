package amqp

// Маппинг доставки → доменный вердикт: у processed/refunded вердикт
// в поле status, у expired его несёт сам routing key.

import (
	"testing"

	amqp091 "github.com/rabbitmq/amqp091-go"
)

func delivery(rk, body string) amqp091.Delivery {
	return amqp091.Delivery{RoutingKey: rk, Body: []byte(body)}
}

func TestToOutcome(t *testing.T) {
	t.Run("processed — вердикт из status", func(t *testing.T) {
		o, err := toOutcome(delivery(keyProcessed,
			`{"bookingId":"b-1","status":"CONFIRMED","message":"ок","processedBy":"go-worker-1"}`))
		if err != nil {
			t.Fatal(err)
		}
		if o.Verdict != "CONFIRMED" || o.BookingID != "b-1" || o.ProcessedBy != "go-worker-1" {
			t.Fatalf("outcome = %+v", o)
		}
	})

	t.Run("refunded — вердикт из status", func(t *testing.T) {
		o, err := toOutcome(delivery(keyRefunded,
			`{"bookingId":"b-2","status":"REFUND_FAILED","message":"банк отказал"}`))
		if err != nil {
			t.Fatal(err)
		}
		if o.Verdict != "REFUND_FAILED" {
			t.Fatalf("verdict = %q, want REFUND_FAILED", o.Verdict)
		}
	})

	t.Run("expired — вердикт из routing key", func(t *testing.T) {
		o, err := toOutcome(delivery(keyExpired,
			`{"bookingId":"b-3","message":"время вышло","expiredAt":"2026-09-17T12:00:00Z"}`))
		if err != nil {
			t.Fatal(err)
		}
		if o.Verdict != "EXPIRED" || o.BookingID != "b-3" {
			t.Fatalf("outcome = %+v", o)
		}
	})

	t.Run("password.reset — адресат-email едет в BookingID", func(t *testing.T) {
		o, err := toOutcome(delivery(keyPasswordReset,
			`{"email":"anna@example.com","message":"http://localhost:18080/#/reset-password?token=abc"}`))
		if err != nil {
			t.Fatal(err)
		}
		if o.Verdict != "PASSWORD_RESET" || o.BookingID != "anna@example.com" {
			t.Fatalf("outcome = %+v", o)
		}
		const wantLink = "http://localhost:18080/#/reset-password?token=abc"
		if o.Message != wantLink {
			t.Fatalf("message = %q, want ссылка сброса %q", o.Message, wantLink)
		}
	})

	t.Run("password.reset без email — ядовитое", func(t *testing.T) {
		if _, err := toOutcome(delivery(keyPasswordReset, `{"message":"ссылка без адресата"}`)); err == nil {
			t.Fatal("ожидали ошибку: письмо без адресата")
		}
	})

	t.Run("waitlist.seat — адресат-email едет в BookingID", func(t *testing.T) {
		o, err := toOutcome(delivery(keyWaitlistSeat,
			`{"email":"boris@example.com","userId":"u-9","movieTitle":"Дюна","message":"успей забронировать"}`))
		if err != nil {
			t.Fatal(err)
		}
		if o.Verdict != "WAITLIST_SEAT" || o.BookingID != "boris@example.com" {
			t.Fatalf("outcome = %+v", o)
		}
		if o.Message != "успей забронировать" {
			t.Fatalf("message = %q", o.Message)
		}
	})

	t.Run("waitlist.seat без email — ядовитое", func(t *testing.T) {
		if _, err := toOutcome(delivery(keyWaitlistSeat, `{"message":"место есть, адресата нет"}`)); err == nil {
			t.Fatal("ожидали ошибку: письмо без адресата")
		}
	})

	t.Run("битый JSON", func(t *testing.T) {
		if _, err := toOutcome(delivery(keyProcessed, `{не json`)); err == nil {
			t.Fatal("ожидали ошибку разбора")
		}
	})

	t.Run("неизвестный routing key", func(t *testing.T) {
		if _, err := toOutcome(delivery("booking.created", `{"bookingId":"b-4"}`)); err == nil {
			t.Fatal("ожидали ошибку routing key")
		}
	})
}

func TestAttempts(t *testing.T) {
	cases := []struct {
		name    string
		headers amqp091.Table
		want    int
	}{
		{"без заголовков — оригинал", nil, 0},
		{"int32 (как от AMQP-брокера)", amqp091.Table{retryHeader: int32(3)}, 3},
		{"int64", amqp091.Table{retryHeader: int64(1)}, 1},
		{"мусор — считаем оригиналом", amqp091.Table{retryHeader: "много"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := amqp091.Delivery{Headers: tc.headers}
			if got := attempts(d); got != tc.want {
				t.Fatalf("attempts(%v) = %d, want %d", tc.headers, got, tc.want)
			}
		})
	}
}

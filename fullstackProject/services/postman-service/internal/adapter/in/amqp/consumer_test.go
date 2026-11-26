package amqp

import (
	"testing"

	amqp091 "github.com/rabbitmq/amqp091-go"
)

func TestFingerprint(t *testing.T) {
	a := fingerprint("booking.processed", []byte(`{"bookingId":"b-1"}`))
	b := fingerprint("booking.processed", []byte(`{"bookingId":"b-1"}`))
	if a != b {
		t.Error("одинаковое событие должно давать один отпечаток")
	}
	if len(a) != 64 { // sha256 hex
		t.Errorf("отпечаток не sha256-hex: %q", a)
	}
	for _, alien := range []struct {
		rk   string
		body string
	}{
		{"booking.refunded", `{"bookingId":"b-1"}`},  // другой тип
		{"booking.processed", `{"bookingId":"b-2"}`}, // другое тело
	} {
		if fingerprint(alien.rk, []byte(alien.body)) == a {
			t.Errorf("отпечаток коллидирует: %v", alien)
		}
	}
}

func TestAttempts(t *testing.T) {
	cases := []struct {
		headers amqp091.Table
		want    int
	}{
		{nil, 0},
		{amqp091.Table{}, 0},
		{amqp091.Table{retryHeader: "не целое"}, 0},
		{amqp091.Table{retryHeader: int(2)}, 2},
		{amqp091.Table{retryHeader: int16(3)}, 3},
		{amqp091.Table{retryHeader: int32(4)}, 4},
		{amqp091.Table{retryHeader: int64(5)}, 5},
	}
	for _, tc := range cases {
		d := amqp091.Delivery{Headers: tc.headers}
		if got := attempts(d); got != tc.want {
			t.Errorf("attempts(%v) = %d, want %d", tc.headers, got, tc.want)
		}
	}
}

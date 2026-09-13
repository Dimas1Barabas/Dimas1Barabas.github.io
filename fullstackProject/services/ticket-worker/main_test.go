package main

// Тесты без живого брокера: счётчик попыток из заголовков, выбор маршрута
// упавшего сообщения (retry / parking) и вердикт истечения резерва.

import (
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func TestAttempts(t *testing.T) {
	cases := []struct {
		name    string
		headers amqp.Table
		want    int
	}{
		{"без заголовков — оригинал", nil, 0},
		{"пустые заголовки", amqp.Table{}, 0},
		{"int", amqp.Table{retryHeader: 2}, 2},
		{"int32 (как от AMQP-брокера)", amqp.Table{retryHeader: int32(3)}, 3},
		{"int64", amqp.Table{retryHeader: int64(1)}, 1},
		{"мусор — считаем оригиналом", amqp.Table{retryHeader: "много"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := amqp.Delivery{Headers: tc.headers}
			if got := attempts(d); got != tc.want {
				t.Fatalf("attempts(%v) = %d, want %d", tc.headers, got, tc.want)
			}
		})
	}
}

func TestRouteFor(t *testing.T) {
	const max = 3
	cases := []struct {
		name    string
		attempt int
		poison  bool
		want    string
	}{
		{"первый сбой — в retry", 1, false, "retry"},
		{"предпоследняя попытка — ещё в retry", max - 1, false, "retry"},
		{"последняя попытка — в parking", max, false, "parking"},
		{"poison — в parking без ретраев", 1, true, "parking"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := routeFor(tc.attempt, max, tc.poison); got != tc.want {
				t.Fatalf("routeFor(%d, %d, %v) = %q, want %q",
					tc.attempt, max, tc.poison, got, tc.want)
			}
		})
	}
}

func TestExpiredEvent(t *testing.T) {
	cfg := loadConfig()
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	ev := BookingPaymentTimeout{BookingID: "booking-42"}

	got := expiredEvent(cfg, ev, now)

	if got.BookingID != ev.BookingID {
		t.Fatalf("bookingId = %q, want %q", got.BookingID, ev.BookingID)
	}
	if got.ProcessedBy != cfg.WorkerID {
		t.Fatalf("processedBy = %q, want %q", got.ProcessedBy, cfg.WorkerID)
	}
	if got.Message == "" {
		t.Fatal("message пуст — API покажет его пользователю")
	}
	// API читает expiredAt как ISO-дату (new Date(...))
	parsed, err := time.Parse(time.RFC3339, got.ExpiredAt)
	if err != nil {
		t.Fatalf("expiredAt не RFC3339: %v", err)
	}
	if !parsed.Equal(now) {
		t.Fatalf("expiredAt = %v, want %v", parsed, now)
	}
}

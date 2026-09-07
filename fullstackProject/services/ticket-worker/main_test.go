package main

// Тесты retry-механики без живого брокера: счётчик попыток из заголовков
// и выбор маршрута упавшего сообщения (retry / parking).

import (
	"testing"

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

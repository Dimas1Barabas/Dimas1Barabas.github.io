package amqp

import (
	"testing"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"recommendation-service/internal/domain"
)

func delivery(rk, body string) amqp091.Delivery {
	return amqp091.Delivery{RoutingKey: rk, Body: []byte(body)}
}

func TestToSignal(t *testing.T) {
	t.Run("бронь", func(t *testing.T) {
		s, err := toSignal(delivery(keyBookingConfirmed, `{
			"userId": "u1", "movieId": "m1", "movieTitle": "Дюна", "genre": "фантастика",
			"bookingId": "b-77", "occurredAt": "2026-09-24T10:00:00Z"}`))
		if err != nil {
			t.Fatal(err)
		}
		if s.Kind != domain.KindBooking || s.DedupKey != "booking:b-77" {
			t.Fatalf("kind/dedup = %s/%s, want booking/booking:b-77", s.Kind, s.DedupKey)
		}
		if s.MovieTitle != "Дюна" || s.Genre != "фантастика" {
			t.Fatalf("фильм = %q / %q", s.MovieTitle, s.Genre)
		}
		want := time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)
		if !s.OccurredAt.Equal(want) {
			t.Fatalf("OccurredAt = %v, want %v", s.OccurredAt, want)
		}
	})

	t.Run("отзыв", func(t *testing.T) {
		s, err := toSignal(delivery(keyReviewCreated, `{
			"userId": "u1", "movieId": "m2", "genre": "драма",
			"rating": 4, "reviewId": "r-9", "occurredAt": "2026-09-24T10:05:00+03:00"}`))
		if err != nil {
			t.Fatal(err)
		}
		if s.Kind != domain.KindReview || s.Rating != 4 || s.DedupKey != "review:r-9" {
			t.Fatalf("сигнал = %+v, want review/4/review:r-9", s)
		}
	})

	t.Run("пустое occurredAt — нулевое время (проставит use-case)", func(t *testing.T) {
		s, err := toSignal(delivery(keyBookingConfirmed, `{"userId":"u1","movieId":"m1","genre":"g","bookingId":"b1"}`))
		if err != nil {
			t.Fatal(err)
		}
		if !s.OccurredAt.IsZero() {
			t.Fatalf("OccurredAt = %v, want zero", s.OccurredAt)
		}
	})

	t.Run("битый JSON — poison", func(t *testing.T) {
		if _, err := toSignal(delivery(keyBookingConfirmed, `{не json`)); err == nil {
			t.Fatal("хотели ошибку битого JSON")
		}
	})

	t.Run("бронь без bookingId — poison", func(t *testing.T) {
		if _, err := toSignal(delivery(keyBookingConfirmed, `{"userId":"u1","movieId":"m1","genre":"g"}`)); err == nil {
			t.Fatal("хотели ошибку про bookingId")
		}
	})

	t.Run("отзыв без reviewId — poison", func(t *testing.T) {
		if _, err := toSignal(delivery(keyReviewCreated, `{"userId":"u1","movieId":"m1","genre":"g","rating":5}`)); err == nil {
			t.Fatal("хотели ошибку про reviewId")
		}
	})

	t.Run("мусорное occurredAt — poison", func(t *testing.T) {
		if _, err := toSignal(delivery(keyBookingConfirmed,
			`{"userId":"u1","movieId":"m1","genre":"g","bookingId":"b1","occurredAt":"вчера"}`)); err == nil {
			t.Fatal("хотели ошибку RFC3339")
		}
	})

	t.Run("неизвестный routing key — poison", func(t *testing.T) {
		if _, err := toSignal(delivery("recommendation.click", `{"userId":"u1"}`)); err == nil {
			t.Fatal("хотели ошибку routing key")
		}
	})
}

func TestAttempts(t *testing.T) {
	cases := []struct {
		name string
		hdr  any
		want int
	}{
		{"нет заголовка", nil, 0},
		{"int", 1, 1},
		{"int16", int16(2), 2},
		{"int32", int32(3), 3},
		{"int64", int64(4), 4},
		{"мусорный тип", "два", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := amqp091.Delivery{}
			if tc.hdr != nil {
				d.Headers = amqp091.Table{retryHeader: tc.hdr}
			}
			if got := attempts(d); got != tc.want {
				t.Fatalf("attempts = %d, want %d", got, tc.want)
			}
		})
	}
}

package amqp

import (
	"encoding/json"
	"fmt"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"recommendation-service/internal/domain"
)

// toSignal приводит доставку к доменному сигналу. Тип взаимодействия
// определяет routing key, dedup-ключ собирается из типа и идентификатора
// события (bookingId/reviewId) — редоставления гасятся хранилищем.
func toSignal(d amqp091.Delivery) (domain.Signal, error) {
	var p signalPayload
	if err := json.Unmarshal(d.Body, &p); err != nil {
		return domain.Signal{}, fmt.Errorf("не разбирается JSON: %w", err)
	}
	s := domain.Signal{
		UserID:     p.UserID,
		MovieID:    p.MovieID,
		MovieTitle: p.MovieTitle,
		Genre:      p.Genre,
		Rating:     p.Rating,
	}
	switch d.RoutingKey {
	case keyBookingConfirmed:
		if p.BookingID == "" {
			return domain.Signal{}, fmt.Errorf("%s без bookingId (dedup-ключ не собрать)", keyBookingConfirmed)
		}
		s.Kind = domain.KindBooking
		s.DedupKey = "booking:" + p.BookingID
	case keyReviewCreated:
		if p.ReviewID == "" {
			return domain.Signal{}, fmt.Errorf("%s без reviewId (dedup-ключ не собрать)", keyReviewCreated)
		}
		s.Kind = domain.KindReview
		s.DedupKey = "review:" + p.ReviewID
	default:
		return domain.Signal{}, fmt.Errorf("неизвестный routing key %q", d.RoutingKey)
	}

	at, err := parseOccurredAt(p.OccurredAt)
	if err != nil {
		return domain.Signal{}, err
	}
	s.OccurredAt = at
	return s, nil
}

// signalPayload — общая форма событий рекомендаций от NestJS API:
// у брони заполнен bookingId, у отзыва — reviewId и rating.
type signalPayload struct {
	UserID     string `json:"userId"`
	MovieID    string `json:"movieId"`
	MovieTitle string `json:"movieTitle"`
	Genre      string `json:"genre"`
	Rating     int    `json:"rating"`
	BookingID  string `json:"bookingId"`
	ReviewID   string `json:"reviewId"`
	OccurredAt string `json:"occurredAt"` // RFC3339
}

// parseOccurredAt: пустое поле — «сейчас» (проставит use-case),
// мусорное — poison, честный формат — мгновение события.
func parseOccurredAt(v string) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	at, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, fmt.Errorf("occurredAt %q не RFC3339: %w", v, err)
	}
	return at, nil
}

package amqp

import (
	"encoding/json"
	"testing"
	"time"

	"reminder-service/internal/domain"
)

// Тест контракта события без брокера: тело письма собирается доменом,
// поля сериализуются camelCase — их читают notification-service и API.
func TestBuildPayloadContract(t *testing.T) {
	r := domain.Reminder{
		BookingID: "b-1", UserID: "u-1", Email: "u@cine.local",
		MovieID: "m-1", MovieTitle: "Дюна", Hall: "Красный",
		SessionAt:  time.Date(2026, 9, 25, 19, 0, 0, 0, time.UTC),
		Seats:      []string{"5-7", "5-8"},
		RemindedAt: time.Date(2026, 9, 25, 17, 0, 0, 0, time.UTC),
	}

	body, err := json.Marshal(buildPayload(r))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}

	for key, want := range map[string]any{
		"bookingId":  "b-1",
		"userId":     "u-1",
		"email":      "u@cine.local",
		"movieId":    "m-1",
		"movieTitle": "Дюна",
		"hall":       "Красный",
		"sessionAt":  "2026-09-25T19:00:00Z",
		"remindedAt": "2026-09-25T17:00:00Z",
		"message":    r.LetterText(),
	} {
		if got[key] != want {
			t.Errorf("%s = %v, want %v", key, got[key], want)
		}
	}
	seats, ok := got["seats"].([]any)
	if !ok || len(seats) != 2 || seats[0] != "5-7" {
		t.Fatalf("seats = %v, want [5-7 5-8]", got["seats"])
	}
}

func TestRoutingKey(t *testing.T) {
	if RoutingKey != "user.session.reminder" {
		t.Fatalf("routing key = %q, want user.session.reminder", RoutingKey)
	}
}

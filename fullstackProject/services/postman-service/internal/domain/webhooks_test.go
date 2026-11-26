package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWants(t *testing.T) {
	sub := Subscription{Active: true, Events: []string{"booking.processed"}}
	cases := []struct {
		eventType string
		want      bool
	}{
		{"booking.processed", true},
		{"booking.created", false},
	}
	for _, tc := range cases {
		if got := sub.Wants(tc.eventType); got != tc.want {
			t.Errorf("Wants(%q) = %v, want %v", tc.eventType, got, tc.want)
		}
	}

	all := Subscription{Active: true} // пустой фильтр — все события
	for _, et := range EventTypes {
		if !all.Wants(et) {
			t.Errorf("пустой фильтр должен хотеть %s", et)
		}
	}

	paused := Subscription{Active: false} // неактивная не хочет ничего
	if paused.Wants("booking.processed") {
		t.Error("неактивная подписка не должна получать события")
	}
}

func TestIsValidEventType(t *testing.T) {
	for _, et := range EventTypes {
		if !IsValidEventType(et) {
			t.Errorf("%s должен быть валидным", et)
		}
	}
	for _, alien := range []string{"bar.order.created", "loyalty.level.up", "", "booking"} {
		if IsValidEventType(alien) {
			t.Errorf("%q не должен быть валидным", alien)
		}
	}
}

func TestNormalizeEvents(t *testing.T) {
	got := NormalizeEvents([]string{" booking.processed ", "", "booking.processed", "booking.expired"})
	want := []string{"booking.processed", "booking.expired"}
	if len(got) != len(want) {
		t.Fatalf("NormalizeEvents = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("NormalizeEvents[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if empty := NormalizeEvents([]string{"", " "}); len(empty) != 0 {
		t.Errorf("пустой фильтр после нормализации должен остаться пустым: %v", empty)
	}
}

func TestEnvelopeJSON(t *testing.T) {
	// конверт летит партнёру как есть — поля стабильны для документации
	env := Envelope{
		DeliveryID:     "whdl_1",
		SubscriptionID: "whsub_1",
		Type:           "booking.processed",
		OccurredAt:     "2026-11-26T12:00:00Z",
		Data:           json.RawMessage(`{"bookingId":"b-1","status":"CONFIRMED"}`),
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, frag := range []string{
		`"deliveryId":"whdl_1"`,
		`"subscriptionId":"whsub_1"`,
		`"type":"booking.processed"`,
		`"occurredAt":"2026-11-26T12:00:00Z"`,
		`"bookingId":"b-1"`,
	} {
		if !strings.Contains(string(raw), frag) {
			t.Errorf("конверт без фрагмента %s: %s", frag, raw)
		}
	}
}

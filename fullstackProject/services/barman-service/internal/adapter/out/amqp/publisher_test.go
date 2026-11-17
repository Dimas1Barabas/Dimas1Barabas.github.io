package amqp

import (
	"encoding/json"
	"testing"
	"time"

	"barman-service/internal/domain"
)

// Routing-ключ по одному на статус: notification биндит только ready.
func TestRoutingKeyFor(t *testing.T) {
	cases := map[domain.Status]string{
		domain.StatusPreparing: "bar.order.preparing",
		domain.StatusReady:     "bar.order.ready",
		domain.StatusPickedUp:  "bar.order.picked_up",
	}
	for status, want := range cases {
		if got := RoutingKeyFor(status); got != want {
			t.Fatalf("RoutingKeyFor(%s) = %s, ожидался %s", status, got, want)
		}
	}
}

// Контракт события: camelCase-поля, RFC3339-время, статус строкой.
// Читающая сторона — NestJS API (BarOrderStatusEvent) и
// notification-service; тест держит имена полей намертво.
func TestBuildPayloadContract(t *testing.T) {
	changed := time.Date(2026, 11, 17, 12, 3, 0, 0, time.UTC)
	body, err := json.Marshal(buildPayload(domain.Order{
		OrderID:      "o-1",
		Status:       domain.StatusReady,
		Email:        "anna@test.local",
		CustomerName: "Анна",
		ChangedAt:    changed,
	}))
	if err != nil {
		t.Fatal(err)
	}

	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"orderId":      "o-1",
		"status":       "READY",
		"email":        "anna@test.local",
		"customerName": "Анна",
		"changedAt":    "2026-11-17T12:03:00Z",
	}
	for key, expected := range want {
		got, ok := raw[key]
		if !ok || got != expected {
			t.Fatalf("поле %s = %v (%T), ожидалось %v", key, got, got, expected)
		}
	}
	if len(raw) != len(want) {
		t.Fatalf("лишние поля в контракте: %v", raw)
	}
}

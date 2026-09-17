package httpapi

// HTTP-адаптер проверяется на настоящем httptest-сервере, но с реальным
// use-case и memory-адаптерами — стек целиком, кроме брокера.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"notification-service/internal/adapter/out/memory"
	"notification-service/internal/domain"
	"notification-service/internal/service"
)

type discardSender struct{}

func (discardSender) Send(context.Context, domain.Notification) error { return nil }

func newTestServer(t *testing.T) (*httptest.Server, *memory.Metrics) {
	t.Helper()
	metrics := memory.NewMetrics()
	svc := service.NewNotifier(discardSender{}, memory.NewRepository(100), metrics)
	ts := httptest.NewServer(New("127.0.0.1:0", svc).Handler)
	t.Cleanup(ts.Close)
	return ts, metrics
}

func TestHealth(t *testing.T) {
	ts, _ := newTestServer(t)

	res, err := ts.Client().Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("код = %d, want 200", res.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %v", body)
	}
}

func TestNotificationsEmpty(t *testing.T) {
	ts, _ := newTestServer(t)

	res, err := ts.Client().Get(ts.URL + "/notifications")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct {
		Items []domain.Notification `json:"items"`
		Count int                   `json:"count"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Count != 0 || len(body.Items) != 0 {
		t.Fatalf("пустая история: %+v", body)
	}
}

func TestStatsShape(t *testing.T) {
	ts, metrics := newTestServer(t)

	res, err := ts.Client().Get(ts.URL + "/stats")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"service", "uptimeSec", "received", "sent", "failed", "errors", "byKind"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("в /stats нет поля %q: %v", key, body)
		}
	}
	if body["service"] != "notification" || metrics.Snapshot()["sent"] != int64(0) {
		t.Fatalf("stats = %v", body)
	}
}

// limit=abc не должен ронять эндпоинт — дефолт 50.
func TestNotificationsBadLimit(t *testing.T) {
	ts, _ := newTestServer(t)

	res, err := ts.Client().Get(ts.URL + "/notifications?limit=abc")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("код = %d, want 200", res.StatusCode)
	}
	if !strings.Contains(res.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("content-type = %q", res.Header.Get("Content-Type"))
	}
}

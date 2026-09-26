package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"ratelimiter-service/internal/adapter/out/memory"
	"ratelimiter-service/internal/domain"
	"ratelimiter-service/internal/service"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	policies := map[domain.Action]domain.Policy{
		domain.ActionBookingsCreate: domain.PolicyOf(2),
		domain.ActionAuthLogin:      domain.PolicyOf(5),
	}
	svc := service.NewLimiter(memory.NewStore(), policies)
	srv := New(":0", svc)
	ts := httptest.NewServer(srv.Handler)
	t.Cleanup(ts.Close)
	return ts
}

func TestHealth(t *testing.T) {
	ts := newTestServer(t)
	res, err := ts.Client().Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("код = %d", res.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("тело = %v", body)
	}
}

func TestBucketsShowcase(t *testing.T) {
	// выжигаем корзину брони (ёмкость 2) — витрина увидит отказ
	svc := service.NewLimiter(memory.NewStore(), map[domain.Action]domain.Policy{
		domain.ActionBookingsCreate: domain.PolicyOf(2),
	})
	_, _ = svc.Check(context.Background(), "bookings.create", "u-1")
	_, _ = svc.Check(context.Background(), "bookings.create", "u-1")
	_, _ = svc.Check(context.Background(), "bookings.create", "u-1")

	ts2 := httptest.NewServer(New(":0", svc).Handler)
	defer ts2.Close()

	res, err := ts2.Client().Get(ts2.URL + "/buckets")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct {
		Buckets []struct {
			Action string  `json:"action"`
			Key    string  `json:"key"`
			Tokens float64 `json:"tokens"`
			Taken  bool    `json:"taken"`
		} `json:"buckets"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Buckets) != 1 {
		t.Fatalf("корзин = %d, ожидали 1 (клиент с пустым ts не шумит)", len(body.Buckets))
	}
	b := body.Buckets[0]
	if b.Action != "bookings.create" || b.Key != "u-1" {
		t.Fatalf("строка = %+v", b)
	}
	if b.Taken {
		t.Fatalf("третья подряд при ёмкости 2 — отказ, витрина должна показать вердикт")
	}
}

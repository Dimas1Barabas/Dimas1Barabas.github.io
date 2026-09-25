package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"pricing-service/internal/adapter/out/memory"
	"pricing-service/internal/service"
)

func TestHealth(t *testing.T) {
	srv := New("127.0.0.1:0", service.NewPricer(memory.NewStore()))
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if rec.Code != 200 {
		t.Fatalf("код = %d, want 200", rec.Code)
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Status != "ok" {
		t.Fatalf("тело = %s (%v)", rec.Body.String(), err)
	}
}

func TestPricesShowcase(t *testing.T) {
	store := memory.NewStore()
	svc := service.NewPricer(store)
	ctx := context.Background()

	// событие спроса + проведённый квот — витрина показывает оба
	if _, err := store.ApplyHeld(ctx, "s-1", "b-1", 70); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Quote(ctx, service.QuoteRequest{
		SessionID:    "s-1",
		SessionAt:    time.Date(2026, time.September, 22, 19, 0, 0, 0, time.Local),
		BasePriceRub: 400,
		Capacity:     80,
	}); err != nil {
		t.Fatal(err)
	}

	srv := New("127.0.0.1:0", svc)

	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/prices", nil))
	if rec.Code != 200 {
		t.Fatalf("код = %d, want 200", rec.Code)
	}
	var prices struct {
		Quotes []struct {
			SessionID string `json:"sessionId"`
			PriceRub  int    `json:"priceRub"`
			Factors   string `json:"factors"`
		} `json:"quotes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &prices); err != nil {
		t.Fatal(err)
	}
	if len(prices.Quotes) != 1 || prices.Quotes[0].SessionID != "s-1" {
		t.Fatalf("витрина квотов пуста: %s", rec.Body.String())
	}
	if prices.Quotes[0].Factors == "" {
		t.Fatalf("раскладка факторов не приехала: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest("GET", "/demand", nil))
	if rec.Code != 200 {
		t.Fatalf("код = %d, want 200", rec.Code)
	}
	var demand struct {
		Demand []struct {
			SessionID string `json:"sessionId"`
			Occupied  int    `json:"occupied"`
		} `json:"demand"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &demand); err != nil {
		t.Fatal(err)
	}
	if len(demand.Demand) != 1 || demand.Demand[0].Occupied != 70 {
		t.Fatalf("витрина спроса неверна: %s", rec.Body.String())
	}
}

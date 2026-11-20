package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"detective-service/internal/adapter/out/memory"
	"detective-service/internal/adapter/out/prom"
	"detective-service/internal/domain"
	"detective-service/internal/service"
)

var t40 = domain.Thresholds{Review: 40, Block: 70}

func TestHealth(t *testing.T) {
	ts := httptest.NewServer(New(":0", service.NewDetective(memory.NewStore(), t40), prom.New().Handler()).Handler)
	defer ts.Close() // httptest.Server.Close не возвращает ошибку

	res, err := ts.Client().Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
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

func TestDecisionsShowcase(t *testing.T) {
	svc := service.NewDetective(memory.NewStore(), t40)
	ctx := context.Background()
	// спокойная бронь и очередь ревью — витрина покажет обе, свежой сверху
	if _, err := svc.Score(ctx, domain.Facts{BookingID: "b-calm", UserID: "u-1", AccountAgeDays: 30}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Score(ctx, domain.Facts{BookingID: "b-fast", UserID: "u-2", AccountAgeDays: 0, Bookings24h: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Resolve(ctx, "b-fast", string(domain.ResolveApprove), "admin@test.local"); err != nil {
		t.Fatal(err)
	}

	ts := httptest.NewServer(New(":0", svc, prom.New().Handler()).Handler)
	defer ts.Close()

	res, err := ts.Client().Get(ts.URL + "/decisions")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var body struct {
		Decisions []struct {
			BookingID  string   `json:"bookingId"`
			Verdict    string   `json:"verdict"`
			Status     string   `json:"status"`
			ResolvedBy string   `json:"resolvedBy"`
			Reasons    []string `json:"reasons"`
			Facts      struct {
				Bookings24h int `json:"bookings24h"`
			} `json:"facts"`
		} `json:"decisions"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Decisions) != 2 {
		t.Fatalf("решений = %d, ожидали 2", len(body.Decisions))
	}
	fresh := body.Decisions[0]
	if fresh.BookingID != "b-fast" || fresh.Status != "approved" || fresh.ResolvedBy != "admin@test.local" {
		t.Fatalf("свежая строка: %+v", fresh)
	}
	if len(fresh.Reasons) != 2 || fresh.Facts.Bookings24h != 5 {
		t.Fatalf("факты/причины: %+v", fresh)
	}
}

// фильтр очереди ревью — рабочая очередь админки
func TestDecisionsStatusFilter(t *testing.T) {
	svc := service.NewDetective(memory.NewStore(), t40)
	ctx := context.Background()
	if _, err := svc.Score(ctx, domain.Facts{BookingID: "b-calm", UserID: "u-1", AccountAgeDays: 30}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Score(ctx, domain.Facts{BookingID: "b-fast", UserID: "u-2", AccountAgeDays: 0, Bookings24h: 5}); err != nil {
		t.Fatal(err)
	}

	ts := httptest.NewServer(New(":0", svc, prom.New().Handler()).Handler)
	defer ts.Close()

	res, err := ts.Client().Get(ts.URL + "/decisions?status=pending_review")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var body struct {
		Decisions []struct {
			BookingID string `json:"bookingId"`
			Status    string `json:"status"`
		} `json:"decisions"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Decisions) != 1 || body.Decisions[0].BookingID != "b-fast" {
		t.Fatalf("очередь ревью: %+v", body.Decisions)
	}
}

// корневой маршрут — паспорт сервиса (список эндпоинтов витрины)
func TestRootIndex(t *testing.T) {
	ts := httptest.NewServer(New(":0", service.NewDetective(memory.NewStore(), t40), prom.New().Handler()).Handler)
	defer ts.Close()

	res, err := ts.Client().Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["service"] != "detective-service" {
		t.Fatalf("паспорт: %v", body)
	}
}

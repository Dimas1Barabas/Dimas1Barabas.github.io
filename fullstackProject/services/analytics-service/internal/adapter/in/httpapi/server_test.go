package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"analytics-service/internal/adapter/out/memory"
	"analytics-service/internal/domain"
	"analytics-service/internal/service"
)

func newServer() *http.Server {
	return New(":0", service.NewAnalyzer(memory.NewStore()), http.NotFoundHandler())
}

func TestHealth(t *testing.T) {
	srv := newServer()
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("health: %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["status"] != "ok" {
		t.Fatalf("health-тело: %v %q", err, rec.Body.String())
	}
}

func TestInsightsAveragesAndConversion(t *testing.T) {
	store := memory.NewStore()
	svc := service.NewAnalyzer(store)
	ctx := httptest.NewRequest(http.MethodGet, "/insights", nil).Context()

	// конверсия m-1: 4 открытия / 1 бронь = 25%; средний dwell home
	// (2 просмотра, 8 с) = 4000 мс; модалка session: 2 события по 3 с
	for i := 0; i < 4; i++ {
		_ = svc.HandleWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventBookingModalOpen, MovieID: "m-1"})
	}
	_ = svc.HandleWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventPageView, Route: "home"})
	_ = svc.HandleWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventPageView, Route: "home"})
	_ = svc.HandleWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventPageDwell, Route: "home", MS: 3000})
	_ = svc.HandleWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventPageDwell, Route: "home", MS: 5000})
	_ = svc.HandleWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventModalDwell, MovieID: "m-1", Deepest: "session", MS: 3000})
	_ = svc.HandleWebEvent(ctx, domain.Event{AID: "a", Type: domain.EventModalDwell, MovieID: "m-1", Deepest: "session", MS: 3000})
	_ = svc.HandleBookingPaid(ctx, "b-1", "m-1")

	srv := New(":0", svc, http.NotFoundHandler())
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/insights", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("insights: %d, тело: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Funnel []struct {
			Step  string `json:"step"`
			Count int64  `json:"count"`
		} `json:"funnel"`
		Movies []struct {
			MovieID           string `json:"movieId"`
			Opens             int64  `json:"opens"`
			ConversionPercent int64  `json:"conversionPercent"`
		} `json:"movies"`
		Pages []struct {
			Route      string `json:"route"`
			AvgDwellMS int64  `json:"avgDwellMs"`
		} `json:"pages"`
		Modal []struct {
			Deepest string `json:"deepest"`
			AvgMS   int64  `json:"avgMs"`
		} `json:"modal"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не JSON: %v (%s)", err, rec.Body.String())
	}

	if len(body.Movies) != 1 || body.Movies[0].ConversionPercent != 25 {
		t.Fatalf("конверсия m-1 = 25%%: %+v", body.Movies)
	}
	if len(body.Pages) != 1 || body.Pages[0].AvgDwellMS != 4000 {
		t.Fatalf("средний dwell home = 4000: %+v", body.Pages)
	}
	if len(body.Modal) != 1 || body.Modal[0].AvgMS != 3000 {
		t.Fatalf("среднее время модалки = 3000: %+v", body.Modal)
	}
	if len(body.Funnel) != 2 { // modal_open + paid
		t.Fatalf("воронка: %+v", body.Funnel)
	}
}

func TestRootListsEndpoints(t *testing.T) {
	srv := newServer()
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body["service"] != "analytics-service" {
		t.Fatalf("корень: %v (%s)", err, rec.Body.String())
	}
}

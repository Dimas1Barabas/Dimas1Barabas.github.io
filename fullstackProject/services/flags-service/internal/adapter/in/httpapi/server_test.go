package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"flags-service/internal/adapter/out/memory"
	"flags-service/internal/adapter/out/prom"
	"flags-service/internal/domain"
	"flags-service/internal/service"
)

func newTestServer() *http.Server {
	return New(":0", service.New(memory.NewStore()), prom.New().Handler())
}

func getJSON(t *testing.T, h http.Handler, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var body map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("ответ не JSON (%s): %v", path, err)
	}
	return rec.Code, body
}

func TestHealth(t *testing.T) {
	code, body := getJSON(t, newTestServer().Handler, "/health")
	if code != http.StatusOK || body["status"] != "ok" {
		t.Fatalf("health: %d %+v", code, body)
	}
}

func TestFlagsListAndRevisions(t *testing.T) {
	svc := service.New(memory.NewStore())
	ctx := context.Background()

	if _, err := svc.Upsert(ctx, domain.Flag{Key: "checkout.new_flow", Description: "новый чекаут", Enabled: true, Percentage: 15, UpdatedBy: "qa"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "checkout.new_flow", Description: "новый чекаут", Enabled: true, Percentage: 40, UpdatedBy: "admin"}); err != nil {
		t.Fatal(err)
	}

	h := New(":0", svc, prom.New().Handler()).Handler

	code, body := getJSON(t, h, "/flags")
	if code != http.StatusOK {
		t.Fatalf("/flags: %d", code)
	}
	rows := body["flags"].([]any)
	if len(rows) != 1 {
		t.Fatalf("один флаг в витрине: %+v", rows)
	}
	row := rows[0].(map[string]any)
	if row["key"] != "checkout.new_flow" || row["percentage"].(float64) != 40 || row["updatedBy"] != "admin" {
		t.Fatalf("маппинг витрины: %+v", row)
	}

	// аудит: свежая правка сверху, без key — 400
	code, body = getJSON(t, h, "/flags/revisions?key=checkout.new_flow")
	if code != http.StatusOK {
		t.Fatalf("/flags/revisions: %d", code)
	}
	revs := body["revisions"].([]any)
	if len(revs) != 2 {
		t.Fatalf("две правки в аудите: %+v", revs)
	}
	top := revs[0].(map[string]any)
	snap := top["snapshot"].(map[string]any)
	if snap["percentage"].(float64) != 40 {
		t.Fatalf("свежая правка сверху: %+v", top)
	}
	if code, _ := getJSON(t, h, "/flags/revisions"); code != http.StatusBadRequest {
		t.Fatalf("без key — 400, получили %d", code)
	}
}

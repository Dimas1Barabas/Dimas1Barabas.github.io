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
	store := memory.NewStore()
	return New(":0", service.New(store, store), prom.New().Handler())
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
	store := memory.NewStore()
	svc := service.New(store, store)
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

// витрина экспериментов: варианты в /flags, метрики с CR в /experiments
func TestExperimentsVitrine(t *testing.T) {
	store := memory.NewStore()
	svc := service.New(store, store)
	ctx := context.Background()

	// эксперимент 15/20: база — остальные 65%; user-2 (бакет 10) — a
	if _, err := svc.Upsert(ctx, domain.Flag{
		Key: "checkout.new_flow", Description: "A/B чекаута", Enabled: true, UpdatedBy: "qa",
		Variants: []domain.Variant{
			{Name: "a", Percentage: 15},
			{Name: "b", Percentage: 20},
		},
	}); err != nil {
		t.Fatal(err)
	}
	// обычный флаг 15%: user-2 — on (бакет 10), user-1 (99) — off
	if _, err := svc.Upsert(ctx, domain.Flag{Key: "booking.qr_v2", Description: "QR v2", Enabled: true, Percentage: 15, UpdatedBy: "qa"}); err != nil {
		t.Fatal(err)
	}

	h := New(":0", svc, prom.New().Handler()).Handler

	// /flags несёт конфигурацию вариантов
	_, body := getJSON(t, h, "/flags")
	rows := body["flags"].([]any)
	byKey := map[string]map[string]any{}
	for _, r := range rows {
		m := r.(map[string]any)
		byKey[m["key"].(string)] = m
	}
	vars := byKey["checkout.new_flow"]["variants"].([]any)
	if len(vars) != 2 || vars[0].(map[string]any)["name"] != "a" {
		t.Fatalf("варианты в витрине флагов: %+v", vars)
	}
	if v := byKey["booking.qr_v2"]["variants"].([]any); len(v) != 0 {
		t.Fatalf("у обычного флага вариантов нет: %+v", v)
	}

	// отчёты: эксперимент — a и база; обычный флаг — on/off
	if _, _, err := svc.ReportExposure(ctx, "checkout.new_flow", "user-2"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.ReportConversion(ctx, "checkout.new_flow", "user-2"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.ReportExposure(ctx, "checkout.new_flow", "user-1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.ReportExposure(ctx, "booking.qr_v2", "user-2"); err != nil {
		t.Fatal(err)
	}

	code, body := getJSON(t, h, "/experiments")
	if code != http.StatusOK {
		t.Fatalf("/experiments: %d", code)
	}
	exps := body["experiments"].([]any)
	byVariant := map[string]map[string]any{}
	for _, e := range exps {
		m := e.(map[string]any)
		key := m["key"].(string)
		if key == "checkout.new_flow" {
			byVariant[m["variant"].(string)] = m
		}
	}
	a := byVariant["a"]
	if a == nil || a["exposures"].(float64) != 1 || a["conversions"].(float64) != 1 || a["cr"].(float64) != 1 {
		t.Fatalf("вариант a: 1/1/CR=1: %+v", a)
	}
	if a["trafficPct"].(float64) != 15 {
		t.Fatalf("доля варианта a из конфига: %+v", a["trafficPct"])
	}
	base := byVariant[""]
	if base == nil || base["exposures"].(float64) != 1 || base["cr"].(float64) != 0 {
		t.Fatalf("база: 1 экспозиция без конверсий, CR=0: %+v", base)
	}
	if base["trafficPct"].(float64) != 65 {
		t.Fatalf("база — остаток 100−35: %+v", base["trafficPct"])
	}

	// удалённый флаг: метрики живут, доля неизвестна (null)
	if _, _, err := svc.ReportExposure(ctx, "booking.qr_v2", "user-2"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Delete(ctx, "booking.qr_v2"); err != nil {
		t.Fatal(err)
	}
	_, body = getJSON(t, h, "/experiments")
	var qrRow map[string]any
	for _, e := range body["experiments"].([]any) {
		m := e.(map[string]any)
		if m["key"] == "booking.qr_v2" {
			qrRow = m
		}
	}
	// вариант не проверяем — он решён бакетингом этого ключа; важны
	// сами счётчики (пережили удаление) и неизвестная доля (null)
	if qrRow == nil || qrRow["exposures"].(float64) != 2 || qrRow["trafficPct"] != nil {
		t.Fatalf("удалённый флаг: метрики живы, доля null: %+v", qrRow)
	}
}

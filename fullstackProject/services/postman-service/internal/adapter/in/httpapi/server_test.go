package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"postman-service/internal/adapter/out/memory"
	"postman-service/internal/adapter/out/prom"
	"postman-service/internal/domain"
	"postman-service/internal/service"
)

// silentSender — партнёр, который всегда «принимает».
type silentSender struct{}

func (silentSender) Send(_ context.Context, _ domain.Subscription, _ domain.Envelope) error {
	return nil
}

func newVitrine(t *testing.T) (*httptest.Server, *memory.Store) {
	t.Helper()
	store := memory.NewStore()
	clock := &fixedClock{now: time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)}
	p := service.New(store.Subs, store.Deliveries, silentSender{}, nil, 3, 2*time.Second, 25)
	p.SetClock(clock.Now)
	srv := httptest.NewServer(New(":0", p, prom.New()).Handler)
	t.Cleanup(srv.Close)
	return srv, store
}

type fixedClock struct{ now time.Time }

func (c *fixedClock) Now() time.Time { return c.now }

func postJSON(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return resp
}

func TestSubscriptionLifecycle(t *testing.T) {
	srv, _ := newVitrine(t)

	// создать: секрет показан один раз, полный
	resp := postJSON(t, srv.URL+"/subscriptions", map[string]any{
		"url":    "http://partner.local/hook",
		"events": []string{"booking.processed"},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("создание: %d", resp.StatusCode)
	}
	var created struct {
		ID     string   `json:"id"`
		Secret string   `json:"secret"`
		Events []string `json:"events"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&created)
	_ = resp.Body.Close()
	if created.ID == "" || len(created.Secret) < 20 {
		t.Fatalf("создание без id/секрета: %+v", created)
	}

	// список: секрет замаскирован
	resp, err := http.Get(srv.URL + "/subscriptions")
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	var list struct {
		Subscriptions []struct {
			ID     string `json:"id"`
			Secret string `json:"secret"`
		} `json:"subscriptions"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&list)
	_ = resp.Body.Close()
	if len(list.Subscriptions) != 1 {
		t.Fatalf("в списке %d подписок", len(list.Subscriptions))
	}
	if list.Subscriptions[0].Secret == created.Secret {
		t.Error("список отдаёт полный секрет — только маска")
	}

	// мусорный URL — 400
	resp = postJSON(t, srv.URL+"/subscriptions", map[string]any{"url": "не-url"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("мусорный URL: %d, want 400", resp.StatusCode)
	}
	_ = resp.Body.Close()

	// удалить
	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/subscriptions/"+created.ID, nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("удаление: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("удаление: %d", resp.StatusCode)
	}

	// повторное удаление — 404
	resp, _ = http.DefaultClient.Do(req)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("повторное удаление: %d, want 404", resp.StatusCode)
	}
}

func TestDeliveriesShowcaseAndReplay(t *testing.T) {
	srv, store := newVitrine(t)
	ctx := t.Context()

	// подготовим данные напрямую через use-case: подписка + мёртвая доставка
	sub, err := subscribeDirect(t, srv)
	if err != nil {
		t.Fatalf("подписка: %v", err)
	}
	_ = store.Deliveries.Enqueue(ctx, []domain.Delivery{{
		ID:             "whdl_dead",
		SubscriptionID: sub.ID,
		EventID:        "evt1",
		EventType:      "booking.processed",
		Status:         domain.StatusDead,
		Attempts:       3,
		LastError:      "HTTP 500 от http://partner.local/hook",
		CreatedAt:      time.Now().Add(-time.Minute),
	}})
	_ = store.Deliveries.Enqueue(ctx, []domain.Delivery{{
		ID:             "whdl_ok",
		SubscriptionID: sub.ID,
		EventID:        "evt2",
		EventType:      "booking.created",
		Status:         domain.StatusDelivered,
		Attempts:       1,
		CreatedAt:      time.Now(),
	}})

	// витрина: список + итоги
	resp, err := http.Get(srv.URL + "/deliveries?status=dead")
	if err != nil {
		t.Fatalf("витрина: %v", err)
	}
	var page struct {
		Deliveries []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"deliveries"`
		Counts map[string]int `json:"counts"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&page)
	_ = resp.Body.Close()
	if len(page.Deliveries) != 1 || page.Deliveries[0].ID != "whdl_dead" {
		t.Fatalf("фильтр dead не работает: %+v", page.Deliveries)
	}
	if page.Counts["dead"] != 1 || page.Counts["delivered"] != 1 {
		t.Fatalf("итоги не сходятся: %+v", page.Counts)
	}

	// перепосылка мёртвой: 200 +queued
	resp = postJSON(t, srv.URL+"/deliveries/whdl_dead/replay", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("replay: %d", resp.StatusCode)
	}
	var revived struct {
		Status   string `json:"status"`
		Attempts int    `json:"attempts"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&revived)
	_ = resp.Body.Close()
	if revived.Status != "queued" || revived.Attempts != 0 {
		t.Fatalf("после replay ждём queued/0: %+v", revived)
	}

	// перепосылка той же (уже queued) — 409
	resp = postJSON(t, srv.URL+"/deliveries/whdl_dead/replay", nil)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Errorf("повторный replay: %d, want 409", resp.StatusCode)
	}

	// несуществующей — 404
	resp = postJSON(t, srv.URL+"/deliveries/whdl_netu/replay", nil)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("чужой id: %d, want 404", resp.StatusCode)
	}
}

// subscribeDirect — подписка через витрину (как оператор).
func subscribeDirect(t *testing.T, srv *httptest.Server) (domain.Subscription, error) {
	t.Helper()
	resp := postJSON(t, srv.URL+"/subscriptions", map[string]any{
		"url":    fmt.Sprintf("http://partner-%d.local/hook", time.Now().UnixNano()),
		"events": nil,
	})
	if resp.StatusCode != http.StatusCreated {
		return domain.Subscription{}, fmt.Errorf("создание: %d", resp.StatusCode)
	}
	var sub domain.Subscription
	_ = json.NewDecoder(resp.Body).Decode(&sub)
	_ = resp.Body.Close()
	return sub, nil
}

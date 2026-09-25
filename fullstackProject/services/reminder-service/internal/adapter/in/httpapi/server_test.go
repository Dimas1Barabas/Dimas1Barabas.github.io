package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"reminder-service/internal/adapter/out/memory"
	"reminder-service/internal/domain"
	"reminder-service/internal/service"
)

func start(t *testing.T) (*httptest.Server, *service.Scheduler) {
	t.Helper()
	scheduler := service.NewScheduler(memory.NewStore(), nopPublisher{}, 2*time.Hour)
	ts := httptest.NewServer(New("test", scheduler).Handler)
	t.Cleanup(ts.Close)
	return ts, scheduler
}

type nopPublisher struct{}

func (nopPublisher) Publish(context.Context, domain.Reminder) error { return nil }

func TestHealth(t *testing.T) {
	ts, _ := start(t)

	resp, err := ts.Client().Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("код /health = %d, want 200", resp.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %v, want status ok", body)
	}
}

func TestRemindersListAndFilter(t *testing.T) {
	ts, scheduler := start(t)
	ctx := context.Background()
	for _, r := range []domain.Reminder{
		{BookingID: "b-1", UserID: "u-1", Email: "a@cine.local", MovieTitle: "Дюна",
			Hall: "Красный", SessionAt: time.Now().Add(5 * time.Hour),
			Seats: []string{"5-7"}, Status: domain.StatusScheduled},
		{BookingID: "b-2", UserID: "u-2", Email: "b@cine.local", MovieTitle: "Скрик",
			Hall: "Синий", SessionAt: time.Now().Add(6 * time.Hour),
			Seats: []string{"2-1"}, Status: domain.StatusScheduled},
	} {
		r.DueAt = r.SessionAt.Add(-2 * time.Hour)
		if _, err := scheduler.Schedule(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	// без фильтра — всё, свежими сверху
	resp, err := ts.Client().Get(ts.URL + "/reminders")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var all struct {
		Reminders []map[string]any `json:"reminders"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&all); err != nil {
		t.Fatal(err)
	}
	if len(all.Reminders) != 2 {
		t.Fatalf("витрина = %d записей, want 2", len(all.Reminders))
	}
	if all.Reminders[0]["bookingId"] != "b-2" {
		t.Fatalf("первая запись = %v, want b-2 (свежие сверху)", all.Reminders[0]["bookingId"])
	}
	if _, has := all.Reminders[0]["email"]; has {
		t.Fatal("email светится в витрине, want скрыт")
	}

	// с фильтром — только свой
	resp, err = ts.Client().Get(ts.URL + "/reminders?userId=u-1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var mine struct {
		Reminders []map[string]any `json:"reminders"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&mine); err != nil {
		t.Fatal(err)
	}
	if len(mine.Reminders) != 1 || mine.Reminders[0]["bookingId"] != "b-1" {
		t.Fatalf("фильтр u-1 = %+v, want одна запись b-1", mine.Reminders)
	}
}

package webhook

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"postman-service/internal/domain"
)

func TestSendSignsAndDelivers(t *testing.T) {
	var gotBody []byte
	var gotSig, gotTS, gotEvent, gotDelivery, gotTrace string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var err error
		gotBody, err = io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("чтение тела: %v", err)
		}
		gotSig = r.Header.Get(HeaderSignature)
		gotTS = r.Header.Get(HeaderTimestamp)
		gotEvent = r.Header.Get(HeaderEvent)
		gotDelivery = r.Header.Get(HeaderDelivery)
		gotTrace = r.Header.Get("traceparent")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	sub := domain.Subscription{ID: "whsub_1", URL: srv.URL, Secret: "whsec_test"}
	env := domain.Envelope{
		DeliveryID:     "whdl_1",
		SubscriptionID: sub.ID,
		Type:           "booking.processed",
		OccurredAt:     "2026-11-26T12:00:00Z",
		Data:           json.RawMessage(`{"bookingId":"b-1"}`),
	}

	client := New(2 * time.Second)
	if err := client.Send(context.Background(), sub, env); err != nil {
		t.Fatalf("Send: %v", err)
	}

	// подпись проверяем той же функцией, что и партнёр
	if !Verify(sub.Secret, gotTS, gotBody, gotSig) {
		t.Errorf("подпись не сходится: sig=%s ts=%s body=%s", gotSig, gotTS, gotBody)
	}
	if gotEvent != "booking.processed" || gotDelivery != "whdl_1" {
		t.Errorf("служебные заголовки: event=%q delivery=%q", gotEvent, gotDelivery)
	}
	if gotTrace != "" {
		t.Errorf("без активного спана traceparent не должен ставиться: %q", gotTrace)
	}
	// тело — ровно конверт
	var back domain.Envelope
	if err := json.Unmarshal(gotBody, &back); err != nil {
		t.Fatalf("тело не конверт: %v", err)
	}
	if back.DeliveryID != env.DeliveryID || back.Type != env.Type {
		t.Errorf("конверт искажён: %+v", back)
	}
}

func TestSendFailsOnNon2xx(t *testing.T) {
	for _, code := range []int{http.StatusInternalServerError, http.StatusNotFound, http.StatusGone, http.StatusMovedPermanently} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(code)
		}))
		sub := domain.Subscription{ID: "s", URL: srv.URL, Secret: "whsec_x"}
		client := New(1 * time.Second)
		if err := client.Send(context.Background(), sub, domain.Envelope{DeliveryID: "d", Data: json.RawMessage(`{}`)}); err == nil {
			t.Errorf("HTTP %d должен быть неудачей", code)
		}
		srv.Close()
	}
}

func TestSendFailsOnUnreachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Close() // адрес уже мёртв

	sub := domain.Subscription{ID: "s", URL: srv.URL, Secret: "whsec_x"}
	client := New(500 * time.Millisecond)
	if err := client.Send(context.Background(), sub, domain.Envelope{DeliveryID: "d", Data: json.RawMessage(`{}`)}); err == nil {
		t.Error("недоступный партнёр должен быть неудачей")
	}
}

func TestVerifyRejectsForged(t *testing.T) {
	body := []byte(`{"a":1}`)
	if !Verify("whsec_test", "1000", body, Sign("whsec_test", "1000", body)) {
		t.Fatal("честная подпись отвергнута")
	}
	for _, alien := range []struct{ secret, ts string }{
		{"whsec_other", "1000"}, // чужой ключ
		{"whsec_test", "1001"},  // подмененное время
	} {
		if Verify(alien.secret, alien.ts, body, Sign("whsec_test", "1000", body)) {
			t.Errorf("подпись с %v принята", alien)
		}
	}
	if Verify("whsec_test", "1000", []byte(`{"a":2}`), Sign("whsec_test", "1000", body)) {
		t.Error("подмененное тело принято")
	}
}

package prom

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"notification-service/internal/adapter/out/memory"
	"notification-service/internal/domain"
)

// Обёртка обязана держать оба мира согласованными: домен вызывает методы
// порта — числа растут и в JSON-срезе обёрнутого адаптера, и в выгрузке
// Prometheus.
func TestWrapperMirrorsIntoBothWorlds(t *testing.T) {
	metrics := New(memory.NewMetrics())

	metrics.Received()
	metrics.Received()
	metrics.Sent(domain.KindConfirmed)
	metrics.Sent(domain.KindConfirmed)
	metrics.Sent(domain.KindExpired)
	metrics.Failed()
	metrics.Errors()

	// JSON-мир: /stats видит агрегаты обёрнутого адаптера
	snapshot := metrics.Snapshot()
	if snapshot["received"] != int64(2) || snapshot["sent"] != int64(3) ||
		snapshot["failed"] != int64(1) || snapshot["errors"] != int64(1) {
		t.Fatalf("snapshot = %v", snapshot)
	}

	// Prometheus-мир: скрейп отдаёт те же числа с разбивкой по kind
	rec := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	for _, want := range []string{
		"cine_notification_received_total 2",
		`cine_notification_sent_total{kind="booking_confirmed"} 2`,
		`cine_notification_sent_total{kind="booking_expired"} 1`,
		"cine_notification_delivery_failed_total 1",
		"cine_notification_errors_total 1",
		"go_goroutines",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("в выгрузке нет строки %q", want)
		}
	}
}

// Новая метка kind появляется в выгрузке только после первого письма —
// пустых рядов CounterVec до дела не плодит.
func TestKindLabelAppearsLazily(t *testing.T) {
	metrics := New(memory.NewMetrics())

	scrape := func() string {
		rec := httptest.NewRecorder()
		metrics.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
		return rec.Body.String()
	}

	if before := scrape(); strings.Contains(before, `kind="password_reset"`) {
		t.Fatalf("до отправки ряд не должен существовать:\n%s", before)
	}
	metrics.Sent(domain.KindPasswordReset)
	if after := scrape(); !strings.Contains(after, `cine_notification_sent_total{kind="password_reset"} 1`) {
		t.Fatalf("после отправки ряд обязателен:\n%s", after)
	}
}

package promstats

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ticket-worker/internal/stats"
)

// Скрейпим Handler как настоящий Prometheus и сверяем строки выгрузки:
// счётчики воркера обязаны отражать текущие атомики stats.Stats.
func TestExporterReflectsStats(t *testing.T) {
	st := stats.New("go-worker-test")
	st.Received.Add(7)
	st.Confirmed.Add(3)
	st.Failed.Add(2)
	st.Expired.Add(1)
	st.Refunds.Add(4)
	st.RefundFailed.Add(1)
	st.Errors.Add(5)

	rec := httptest.NewRecorder()
	New(st).Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("код ответа = %d, хочу 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`cine_worker_verdicts_total{verdict="confirmed"} 3`,
		`cine_worker_verdicts_total{verdict="failed"} 2`,
		`cine_worker_verdicts_total{verdict="expired"} 1`,
		`cine_worker_refunds_total{outcome="done"} 4`,
		`cine_worker_refunds_total{outcome="failed"} 1`,
		"cine_worker_events_received_total 7",
		"cine_worker_errors_total 5",
		"cine_worker_uptime_seconds",
		// стандартные коллекторы тоже в реестре
		"go_goroutines",
		"process_resident_memory_bytes",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("в выгрузке нет строки %q", want)
		}
	}
}

// Pull-модель: между двумя скрейпами счётчик дорастает, выгрузка
// не «застывает» на срезе первого опроса.
func TestExporterIsPullBased(t *testing.T) {
	st := stats.New("go-worker-test")
	exporter := New(st)

	scrape := func() string {
		rec := httptest.NewRecorder()
		exporter.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
		return rec.Body.String()
	}

	first := scrape()
	st.Confirmed.Add(2)
	second := scrape()

	if !strings.Contains(first, `cine_worker_verdicts_total{verdict="confirmed"} 0`) {
		t.Errorf("первый скрейп должен показать 0, получил:\n%s", first)
	}
	if !strings.Contains(second, `cine_worker_verdicts_total{verdict="confirmed"} 2`) {
		t.Errorf("второй скрейп должен показать 2, получил:\n%s", second)
	}
}

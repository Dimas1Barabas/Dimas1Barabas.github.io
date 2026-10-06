// Package httpserver отдаёт служебные эндпоинты: /health для оркестратора,
// /stats — срез счётчиков воркера, /metrics — выгрузку для Prometheus.
package httpserver

import (
	"encoding/json"
	"errors"
	"net/http"

	"ticket-worker/internal/logging"
	"ticket-worker/internal/promstats"
	"ticket-worker/internal/stats"
)

// Start поднимает HTTP-сервер в горутине и возвращает его — вызывающий
// обязан сделать Shutdown при остановке.
func Start(addr string, st *stats.Stats) *http.Server {
	srv := New(addr, st)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logging.Error("http: %v", err)
		}
	}()
	logging.Info("http: /health, /stats и /metrics на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, st *stats.Stats) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, st.Snapshot())
	})
	// Prometheus скрейпит по расписанию; реестр читает атомики
	// stats.Stats в момент опроса — отдельного учёта здесь нет
	mux.Handle("/metrics", promstats.New(st).Handler())
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "ticket-worker",
			"endpoints": []string{"/health", "/stats", "/metrics"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

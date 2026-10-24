// Package httpapi — входящий адаптер: служебные эндпоинты стенда.
// gRPC — основной интерфейс Курьера; HTTP остаётся для health-проб,
// витрины доставки (демо, отладка pending-хвоста) и /metrics.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"outbox-relay/internal/logging"
	"outbox-relay/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
// metricsHandler — prometheus-выгрузка адаптера out/prom.
func Start(addr string, relay *service.Relay, metricsHandler http.Handler) *http.Server {
	srv := New(addr, relay, metricsHandler)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logging.Error("http: %v", err)
		}
	}()
	logging.Info("http: /health и /outbox на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, relay *service.Relay, metricsHandler http.Handler) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", metricsHandler)

	// витрина Курьера: хвост доставки и счётчики — зеркало gRPC Stats
	mux.HandleFunc("/outbox", func(w http.ResponseWriter, r *http.Request) {
		st, err := relay.Stats(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		oldest := ""
		oldestMs := int64(0)
		if !st.OldestPending.IsZero() {
			oldest = st.OldestPending.Format(time.RFC3339)
			oldestMs = time.Since(st.OldestPending).Milliseconds()
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"pending":         st.Pending,
			"oldestPending":   oldest,
			"oldestPendingMs": oldestMs,
			"publishedTotal":  st.PublishedTotal,
			"failedAttempts":  st.FailedAttempts,
		})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "outbox-relay",
			"endpoints": []string{"/health", "/outbox", "/metrics"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

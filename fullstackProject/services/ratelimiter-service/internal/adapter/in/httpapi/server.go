// Package httpapi — входящий адаптер: служебные эндпоинты стенда.
// gRPC — основной интерфейс Привратника; HTTP остаётся для health-проб
// и витрины (как дышат корзины — остатки и вердикты последних проверок).
package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"ratelimiter-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
// metricsHandler — prometheus-выгрузка адаптера out/prom.
func Start(addr string, svc *service.Limiter, metricsHandler http.Handler) *http.Server {
	srv := New(addr, svc, metricsHandler)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	log.Printf("http: /health, /buckets и /metrics на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Limiter, metricsHandler http.Handler) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", metricsHandler)

	// витрина корзин: остатки токенов и вердикты последних проверок,
	// свежие сверху — видно, как лимит режет спам
	mux.HandleFunc("/buckets", func(w http.ResponseWriter, r *http.Request) {
		rows, err := svc.ListBuckets(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(rows))
		for _, b := range rows {
			out = append(out, map[string]any{
				"action":    b.Action,
				"key":       b.Key,
				"tokens":    b.Tokens,
				"taken":     b.Taken,
				"updatedAt": b.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"buckets": out})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "ratelimiter-service",
			"endpoints": []string{"/health", "/buckets", "/metrics"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

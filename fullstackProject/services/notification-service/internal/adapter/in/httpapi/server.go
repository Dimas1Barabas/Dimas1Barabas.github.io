// Package httpapi — входящий адаптер: служебные эндпоинты и история
// уведомлений. Знает о use-case, но не о том, что за ним стоит.
package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"

	"notification-service/internal/domain"
	"notification-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
func Start(addr string, svc *service.Notifier) *http.Server {
	srv := New(addr, svc)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	log.Printf("http: /health, /stats и /notifications на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Notifier) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, svc.Snapshot())
	})
	mux.HandleFunc("/notifications", func(w http.ResponseWriter, r *http.Request) {
		limit := 50
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		items, err := svc.List(r.Context(), domain.Filter{
			BookingID: r.URL.Query().Get("bookingId"),
			Limit:     limit,
		})
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "notification-service",
			"endpoints": []string{"/health", "/stats", "/notifications"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

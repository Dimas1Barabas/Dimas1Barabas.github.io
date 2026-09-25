// Package httpapi — входящий адаптер: служебные эндпоинты стенда.
// gRPC — основной интерфейс напоминаний; HTTP остаётся для health-проб
// и витрины очереди (демо стенда, отладка планирования).
package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"reminder-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
func Start(addr string, svc *service.Scheduler) *http.Server {
	srv := New(addr, svc)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	log.Printf("http: /health и /reminders на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Scheduler) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// витрина очереди: что запланировано, что ушло; email не светим —
	// адресат виден в истории notification-service
	mux.HandleFunc("/reminders", func(w http.ResponseWriter, r *http.Request) {
		userID := r.URL.Query().Get("userId")
		items, err := svc.List(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(items))
		for _, it := range items {
			if userID != "" && it.UserID != userID {
				continue
			}
			remindedAt := ""
			if !it.RemindedAt.IsZero() {
				remindedAt = it.RemindedAt.Format("2006-01-02T15:04:05Z07:00")
			}
			out = append(out, map[string]any{
				"bookingId":  it.BookingID,
				"userId":     it.UserID,
				"movieTitle": it.MovieTitle,
				"hall":       it.Hall,
				"sessionAt":  it.SessionAt.Format("2006-01-02T15:04:05Z07:00"),
				"dueAt":      it.DueAt.Format("2006-01-02T15:04:05Z07:00"),
				"status":     it.Status,
				"remindedAt": remindedAt,
				"seatCount":  len(it.Seats),
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"reminders": out})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "reminder-service",
			"endpoints": []string{"/health", "/reminders?userId=…"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

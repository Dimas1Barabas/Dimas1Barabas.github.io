// Package httpapi — входящий адаптер: служебные эндпоинты стенда.
// gRPC — основной интерфейс Детектива; HTTP остаётся для health-проб
// и витрины решений (админка API читает её через свой fail-soft клиент).
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"detective-service/internal/logging"
	"detective-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
// metricsHandler — prometheus-выгрузка адаптера out/prom.
func Start(addr string, svc *service.Detective, metricsHandler http.Handler) *http.Server {
	srv := New(addr, svc, metricsHandler)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logging.Error("http: %v", err)
		}
	}()
	logging.Info("http: /health, /decisions и /metrics на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Detective, metricsHandler http.Handler) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", metricsHandler)

	// витрина решений: очередь ревью и история вердиктов, свежие сверху;
	// ?status= фильтрует (например, pending_review — рабочая очередь),
	// ?limit= режет хвост (дефолт 200)
	mux.HandleFunc("/decisions", func(w http.ResponseWriter, r *http.Request) {
		limit := 200
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		rows, err := svc.List(r.Context(), r.URL.Query().Get("status"), limit)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(rows))
		for _, d := range rows {
			row := map[string]any{
				"bookingId": d.Facts.BookingID,
				"userId":    d.Facts.UserID,
				"sessionId": d.Facts.SessionID,
				"facts": map[string]int{
					"seatsCount":     d.Facts.SeatsCount,
					"totalRub":       d.Facts.TotalRub,
					"accountAgeDays": d.Facts.AccountAgeDays,
					"bookings24h":    d.Facts.Bookings24h,
					"cancels24h":     d.Facts.Cancels24h,
					"failed24h":      d.Facts.Failed24h,
				},
				"score":      d.Score,
				"verdict":    string(d.Verdict),
				"reasons":    d.Reasons,
				"status":     string(d.Status),
				"resolvedBy": d.ResolvedBy,
				"createdAt":  d.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			}
			if !d.ResolvedAt.IsZero() {
				row["resolvedAt"] = d.ResolvedAt.Format("2006-01-02T15:04:05Z07:00")
			}
			out = append(out, row)
		}
		writeJSON(w, http.StatusOK, map[string]any{"decisions": out})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "detective-service",
			"endpoints": []string{"/health", "/decisions", "/metrics"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

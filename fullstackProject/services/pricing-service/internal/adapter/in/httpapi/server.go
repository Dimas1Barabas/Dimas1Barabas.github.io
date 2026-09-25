// Package httpapi — входящий адаптер: служебные эндпоинты стенда.
// gRPC — основной интерфейс Тарификатора; HTTP остаётся для health-проб
// и витрины (история квотов с раскладкой, проекция спроса).
package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"pricing-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
func Start(addr string, svc *service.Pricer) *http.Server {
	srv := New(addr, svc)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	log.Printf("http: /health, /prices и /demand на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Pricer) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// витрина истории: проведённые квоты с раскладкой факторов,
	// свежими сверху — видно, как цена дышит вместе со спросом
	mux.HandleFunc("/prices", func(w http.ResponseWriter, r *http.Request) {
		quotes, err := svc.ListQuotes(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(quotes))
		for _, q := range quotes {
			out = append(out, map[string]any{
				"sessionId":    q.SessionID,
				"basePriceRub": q.BasePriceRub,
				"priceRub":     q.PriceRub,
				"factors":      q.Factors,
				"createdAt":    q.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"quotes": out})
	})

	// витрина спроса: сколько мест держит проекция по каждому сеансу
	mux.HandleFunc("/demand", func(w http.ResponseWriter, r *http.Request) {
		rows, err := svc.ListDemand(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(rows))
		for _, d := range rows {
			out = append(out, map[string]any{
				"sessionId": d.SessionID,
				"occupied":  d.Occupied,
				"updatedAt": d.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"demand": out})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "pricing-service",
			"endpoints": []string{"/health", "/prices", "/demand"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

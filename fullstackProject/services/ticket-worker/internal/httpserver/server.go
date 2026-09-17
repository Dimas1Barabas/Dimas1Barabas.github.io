// Package httpserver отдаёт служебные эндпоинты: /health для оркестратора
// и /stats — срез счётчиков воркера.
package httpserver

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"ticket-worker/internal/stats"
)

// Start поднимает HTTP-сервер в горутине и возвращает его — вызывающий
// обязан сделать Shutdown при остановке.
func Start(addr string, st *stats.Stats) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, st.Snapshot())
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "ticket-worker",
			"endpoints": []string{"/health", "/stats"},
		})
	})

	srv := &http.Server{Addr: addr, Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	log.Printf("http: /health и /stats на %s", addr)
	return srv
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

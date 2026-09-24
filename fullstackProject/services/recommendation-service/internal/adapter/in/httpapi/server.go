// Package httpapi — входящий адаптер: служебные эндпоинты стенда.
// gRPC — основной интерфейс КиноСоветника; HTTP остаётся для health-проб
// и витрины профиля зрителя (демо стенда, отладка сигналов).
package httpapi

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"recommendation-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
func Start(addr string, svc *service.Advisor) *http.Server {
	srv := New(addr, svc)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	log.Printf("http: /health и /profile на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Advisor) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	// витрина профиля: какие жанровые веса накопил зритель
	mux.HandleFunc("/profile", func(w http.ResponseWriter, r *http.Request) {
		userID := r.URL.Query().Get("userId")
		if userID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "userId обязателен"})
			return
		}
		p, err := svc.Profile(r.Context(), userID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"userId": p.UserID, "genreWeights": p.GenreWeights, "seenCount": len(p.Seen),
		})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "recommendation-service",
			"endpoints": []string{"/health", "/profile?userId=…"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

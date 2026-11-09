// Package httpapi — входящий адаптер: служебные эндпоинты стенда.
// gRPC — основной интерфейс «Суфлёра»; HTTP остаётся для health-проб,
// витрины флагов (как стоит раскатка) и аудита правок.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"flags-service/internal/domain"
	"flags-service/internal/logging"
	"flags-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
// metricsHandler — prometheus-выгрузка адаптера out/prom.
func Start(addr string, svc *service.Flags, metricsHandler http.Handler) *http.Server {
	srv := New(addr, svc, metricsHandler)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logging.Error("http: %v", err)
		}
	}()
	logging.Info("http: /health, /flags, /flags/revisions и /metrics на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Flags, metricsHandler http.Handler) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", metricsHandler)

	// витрина флагов: как стоит раскатка — состояние всех тумблеров
	// и варианты A/B-экспериментов
	mux.HandleFunc("/flags", func(w http.ResponseWriter, r *http.Request) {
		flags, err := svc.List(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(flags))
		for _, f := range flags {
			variants := make([]map[string]any, 0, len(f.Variants))
			for _, v := range f.Variants {
				variants = append(variants, map[string]any{
					"name":       v.Name,
					"percentage": v.Percentage,
				})
			}
			out = append(out, map[string]any{
				"key":         f.Key,
				"description": f.Description,
				"enabled":     f.Enabled,
				"percentage":  f.Percentage,
				"killed":      f.Killed,
				"variants":    variants,
				"updatedBy":   f.UpdatedBy,
				"updatedAt":   f.UpdatedAt.Format(time.RFC3339),
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"flags": out})
	})

	// витрина экспериментов: экспозиции, конверсии и CR по вариантам;
	// конфигурация долей подтягивается из текущего состояния флагов,
	// у удалённого флага метрики остаются (trafficPct = null)
	mux.HandleFunc("/experiments", func(w http.ResponseWriter, r *http.Request) {
		stats, err := svc.ExperimentStats(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		flags, err := svc.List(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(stats))
		for _, st := range stats {
			var cr any
			if st.Exposures > 0 {
				cr = float64(st.Conversions) / float64(st.Exposures)
			}
			out = append(out, map[string]any{
				"key":         st.Key,
				"variant":     st.Variant,
				"exposures":   st.Exposures,
				"conversions": st.Conversions,
				"trafficPct":  variantTraffic(flags, st.Key, st.Variant),
				"cr":          cr,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"experiments": out})
	})

	// аудит правок флага: ?key=checkout.new_flow&limit=20, свежими сверху
	mux.HandleFunc("/flags/revisions", func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get("key")
		if key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key обязателен"})
			return
		}
		limit := 20
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		rows, err := svc.Revisions(r.Context(), key, limit)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		out := make([]map[string]any, 0, len(rows))
		for _, rev := range rows {
			variants := make([]map[string]any, 0, len(rev.Snapshot.Variants))
			for _, v := range rev.Snapshot.Variants {
				variants = append(variants, map[string]any{
					"name":       v.Name,
					"percentage": v.Percentage,
				})
			}
			out = append(out, map[string]any{
				"key":       rev.Key,
				"changedBy": rev.ChangedBy,
				"changedAt": rev.ChangedAt.Format(time.RFC3339),
				"snapshot": map[string]any{
					"enabled":    rev.Snapshot.Enabled,
					"percentage": rev.Snapshot.Percentage,
					"killed":     rev.Snapshot.Killed,
					"variants":   variants,
				},
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"revisions": out})
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "flags-service",
			"endpoints": []string{"/health", "/flags", "/flags/revisions", "/experiments", "/metrics"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

// variantTraffic — доля трафика варианта по ТЕКУЩЕМУ конфигу флага:
// nil — флаг удалён или вариант неизвестен (переименовали). База
// эксперимента — остаток от суммы долей; on/off обычного флага —
// процент раскатки и его дополнение.
func variantTraffic(flags []domain.Flag, key, variant string) *int {
	for _, f := range flags {
		if f.Key != key {
			continue
		}
		sum := 0
		for _, v := range f.Variants {
			sum += v.Percentage
			if v.Name == variant {
				pct := v.Percentage
				return &pct
			}
		}
		if len(f.Variants) > 0 {
			if variant == "" {
				rest := 100 - sum
				return &rest
			}
			return nil
		}
		// обычный флаг: implicit-варианты on/off по проценту раскатки
		switch variant {
		case "on":
			pct := f.Percentage
			return &pct
		case "off":
			rest := 100 - f.Percentage
			return &rest
		}
		return nil
	}
	return nil
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

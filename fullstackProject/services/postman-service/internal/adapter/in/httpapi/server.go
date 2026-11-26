// Package httpapi — входящий адаптер: витрина «Почтальона» и служебные
// эндпоинты. Подписки партнёров заводят и снимают здесь (POST/DELETE
// /subscriptions — секрет показывается один раз при создании),
// доставки смотрят с фильтрами и итогами по статусам, мёртвые и
// доставленные возвращают в очередь кнопкой перепосылки. /health —
// compose-проба, /metrics — Prometheus. Витрина живёт во внутренней
// сети стенда (как экран Бармена): авторизации нет — это инструмент
// оператора, не публичный API.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"postman-service/internal/adapter/out/prom"
	"postman-service/internal/domain"
	"postman-service/internal/logging"
	"postman-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
func Start(addr string, svc *service.Postman, metrics *prom.Metrics) *http.Server {
	srv := New(addr, svc, metrics)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logging.Error("http: %v", err)
		}
	}()
	logging.Info("http: /health, /subscriptions, /deliveries и /metrics на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Postman, metrics *prom.Metrics) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", metrics.Handler())

	// — подписки —

	mux.HandleFunc("GET /subscriptions", func(w http.ResponseWriter, r *http.Request) {
		subs, err := svc.Subscriptions(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		views := make([]subscriptionView, 0, len(subs))
		for _, s := range subs {
			views = append(views, toSubscriptionView(s)) // секрет — только маска
		}
		writeJSON(w, http.StatusOK, map[string]any{"subscriptions": views})
	})

	mux.HandleFunc("POST /subscriptions", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			URL    string   `json:"url"`
			Events []string `json:"events"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "тело не JSON: " + err.Error()})
			return
		}
		sub, err := svc.Subscribe(r.Context(), req.URL, req.Events)
		if err != nil {
			if errors.Is(err, domain.ErrInvalidSubscription) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		// полный секрет — ровно один раз, в ответе создания
		writeJSON(w, http.StatusCreated, fromSubscription(sub))
	})

	mux.HandleFunc("DELETE /subscriptions/{id}", func(w http.ResponseWriter, r *http.Request) {
		deleted, err := svc.Unsubscribe(r.Context(), r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if !deleted {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "подписка не найдена"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
	})

	// — доставки —

	mux.HandleFunc("GET /deliveries", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		limit := 50
		if v := q.Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
				limit = n
			}
		}
		filter := domain.DeliveryFilter{
			SubscriptionID: strings.TrimSpace(q.Get("subscriptionId")),
			Status:         domain.DeliveryStatus(strings.TrimSpace(q.Get("status"))),
			Limit:          limit,
		}
		deliveries, err := svc.Deliveries(r.Context(), filter)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		counts, err := svc.Counts(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		views := make([]deliveryView, 0, len(deliveries))
		for _, d := range deliveries {
			views = append(views, toDeliveryView(d))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"deliveries": views,
			"counts": map[string]int{
				string(domain.StatusQueued):    counts[domain.StatusQueued],
				string(domain.StatusDelivered): counts[domain.StatusDelivered],
				string(domain.StatusDead):      counts[domain.StatusDead],
			},
		})
	})

	// кнопка витрины: вернуть доставку (delivered/dead) в очередь
	mux.HandleFunc("POST /deliveries/{id}/replay", func(w http.ResponseWriter, r *http.Request) {
		d, err := svc.Replay(r.Context(), r.PathValue("id"))
		switch {
		case errors.Is(err, domain.ErrDeliveryNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "доставка не найдена"})
		case errors.Is(err, domain.ErrNotReplayable):
			writeJSON(w, http.StatusConflict, map[string]string{"error": "доставка уже в очереди — перепосылка не нужна"})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusOK, toDeliveryView(d))
		}
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service": "postman-service",
			"endpoints": []string{
				"/health",
				"GET|POST /subscriptions, DELETE /subscriptions/{id}",
				"GET /deliveries?status=&subscriptionId=&limit=, POST /deliveries/{id}/replay",
				"/metrics",
			},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

// — проводники JSON —

// subscriptionView — подписка в списке: секрет замаскирован, полный
// показан один раз при создании (fromSubscription).
type subscriptionView struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Secret    string   `json:"secret,omitempty"` // полный — только в ответе создания
	Events    []string `json:"events"`           // пусто = все события брони
	Active    bool     `json:"active"`
	CreatedAt string   `json:"createdAt"`
}

func fromSubscription(s domain.Subscription) subscriptionView {
	return subscriptionView{
		ID:        s.ID,
		URL:       s.URL,
		Secret:    s.Secret,
		Events:    s.Events,
		Active:    s.Active,
		CreatedAt: s.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}

func toSubscriptionView(s domain.Subscription) subscriptionView {
	v := fromSubscription(s)
	v.Secret = maskSecret(s.Secret)
	return v
}

// maskSecret — «whsec_…abcd»: тип ключа и хвост узнаются, сам ключ нет.
func maskSecret(secret string) string {
	if len(secret) <= 8 {
		return "****"
	}
	return secret[:6] + "…" + secret[len(secret)-4:]
}

type deliveryView struct {
	ID             string  `json:"id"`
	SubscriptionID string  `json:"subscriptionId"`
	EventType      string  `json:"eventType"`
	Status         string  `json:"status"` // queued | delivered | dead
	Attempts       int     `json:"attempts"`
	NextAttemptAt  string  `json:"nextAttemptAt"`
	LastError      string  `json:"lastError"`
	CreatedAt      string  `json:"createdAt"`
	DeliveredAt    *string `json:"deliveredAt"`
}

func toDeliveryView(d domain.Delivery) deliveryView {
	v := deliveryView{
		ID:             d.ID,
		SubscriptionID: d.SubscriptionID,
		EventType:      d.EventType,
		Status:         string(d.Status),
		Attempts:       d.Attempts,
		LastError:      d.LastError,
		CreatedAt:      d.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
	if !d.NextAttemptAt.IsZero() {
		v.NextAttemptAt = d.NextAttemptAt.UTC().Format("2006-01-02T15:04:05Z07:00")
	}
	if d.DeliveredAt != nil {
		s := d.DeliveredAt.UTC().Format("2006-01-02T15:04:05Z07:00")
		v.DeliveredAt = &s
	}
	return v
}

func writeJSON(w http.ResponseWriter, code int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

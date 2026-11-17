// Package httpapi — входящий адаптер: витрина «Экран бара» и служебные
// эндпоинты. /bar — доска очереди (три активные колонки + лента
// закрытых), кнопки /bar/orders/{id}/start|ready|pickup двигают заказ
// по циклу; health — compose-проба, /metrics — Prometheus.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"barman-service/internal/adapter/out/prom"
	"barman-service/internal/domain"
	"barman-service/internal/logging"
	"barman-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
func Start(addr string, svc *service.Barman, metrics *prom.Metrics) *http.Server {
	srv := New(addr, svc, metrics)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logging.Error("http: %v", err)
		}
	}()
	logging.Info("http: /health, /bar и /metrics на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Barman, metrics *prom.Metrics) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", metrics.Handler())

	// доска очереди — читает экран бара и e2e-стенд
	mux.HandleFunc("/bar", func(w http.ResponseWriter, r *http.Request) {
		board, err := svc.Board(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, toBoardView(board))
	})

	// кнопки экрана бара: «в работу» / «готов» / «выдан»
	button := func(action string, call func(ctx context.Context, id string) (domain.Order, error)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("id")
			order, err := call(r.Context(), id)
			switch {
			case errors.Is(err, domain.ErrOrderNotFound):
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "заказ не найден в очереди бара"})
			case errors.Is(err, domain.ErrInvalidTransition):
				writeJSON(w, http.StatusConflict, map[string]string{"error": "переход недоступен: " + err.Error()})
			case err != nil:
				// статус мог сохраниться, но событие не ушло: повторное
				// нажатие репаблишит (502 — брокер, не домен)
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			default:
				metrics.Button(action)
				writeJSON(w, http.StatusOK, toOrderView(order))
			}
		}
	}
	mux.HandleFunc("POST /bar/orders/{id}/start", button("start", svc.Start))
	mux.HandleFunc("POST /bar/orders/{id}/ready", button("ready", svc.Ready))
	mux.HandleFunc("POST /bar/orders/{id}/pickup", button("pickup", svc.PickUp))

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "barman-service",
			"endpoints": []string{"/health", "/bar", "/bar/orders/{id}/start|ready|pickup (POST)", "/metrics"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

// boardView — проводник доски в JSON: колонки NEW/PREPARING/READY и
// лента закрытых со статусами.
type boardView struct {
	New       []orderView `json:"new"`
	Preparing []orderView `json:"preparing"`
	Ready     []orderView `json:"ready"`
	Recent    []orderView `json:"recent"`
}

type orderView struct {
	OrderID      string     `json:"orderId"`
	CustomerName string     `json:"customerName"`
	Session      string     `json:"session"` // «IMAX, Fri 19:30» | «без сеанса»
	Items        []itemView `json:"items"`
	TotalRub     int        `json:"totalRub"`
	Status       string     `json:"status"`
	CreatedAt    string     `json:"createdAt"`
	ChangedAt    string     `json:"changedAt"`
}

type itemView struct {
	ItemID   string `json:"itemId"`
	Name     string `json:"name"`
	PriceRub int    `json:"priceRub"`
	Qty      int    `json:"qty"`
}

func toOrderView(o domain.Order) orderView {
	v := orderView{
		OrderID:      o.OrderID,
		CustomerName: o.CustomerName,
		Session:      o.SessionLabel(),
		TotalRub:     o.TotalRub,
		Status:       string(o.Status),
		CreatedAt:    o.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		ChangedAt:    o.ChangedAt.Format("2006-01-02T15:04:05Z07:00"),
		Items:        make([]itemView, 0, len(o.Items)),
	}
	for _, it := range o.Items {
		v.Items = append(v.Items, itemView{ItemID: it.ItemID, Name: it.Name, PriceRub: it.PriceRub, Qty: it.Qty})
	}
	return v
}

func toBoardView(b domain.Board) boardView {
	mapAll := func(list []domain.Order) []orderView {
		out := make([]orderView, 0, len(list))
		for _, o := range list {
			out = append(out, toOrderView(o))
		}
		return out
	}
	return boardView{
		New:       mapAll(b.New),
		Preparing: mapAll(b.Preparing),
		Ready:     mapAll(b.Ready),
		Recent:    mapAll(b.Recent),
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

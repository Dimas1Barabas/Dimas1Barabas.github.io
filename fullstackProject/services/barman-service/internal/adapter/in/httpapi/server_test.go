package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"barman-service/internal/adapter/out/prom"
	"barman-service/internal/domain"
	"barman-service/internal/service"
)

// Тест витрины без сети: реальный mux и use-cases на Map-фейках —
// адаптер проверяет маршруты и коды ответов, логика — в service-тестах.

type fakeStore struct {
	orders map[string]domain.Order
}

func (s *fakeStore) Upsert(_ context.Context, o domain.Order) error {
	if _, ok := s.orders[o.OrderID]; ok {
		return nil
	}
	s.orders[o.OrderID] = o
	return nil
}

func (s *fakeStore) Get(_ context.Context, id string) (domain.Order, error) {
	o, ok := s.orders[id]
	if !ok {
		return domain.Order{}, domain.ErrOrderNotFound
	}
	return o, nil
}

func (s *fakeStore) Save(_ context.Context, o domain.Order) error {
	if _, ok := s.orders[o.OrderID]; !ok {
		return domain.ErrOrderNotFound
	}
	s.orders[o.OrderID] = o
	return nil
}

func (s *fakeStore) Board(_ context.Context) (domain.Board, error) {
	return domain.Board{New: []domain.Order{s.orders["o-1"]}}, nil
}

type fakePublisher struct{}

func (fakePublisher) PublishStatus(context.Context, domain.Order) error { return nil }

func newServer(t *testing.T) *http.Server {
	t.Helper()
	base := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{orders: map[string]domain.Order{
		"o-1": {
			OrderID: "o-1", Status: domain.StatusNew, CustomerName: "Анна",
			Items:    []domain.Item{{ItemID: "i-1", Name: "Попкорн солёный", PriceRub: 320, Qty: 1}},
			TotalRub: 320, CreatedAt: base, ChangedAt: base,
		},
	}}
	svc := service.NewBarman(store, fakePublisher{})
	return New(":0", svc, prom.New())
}

func TestHealthAndRoot(t *testing.T) {
	srv := newServer(t)
	for path, wantStatus := range map[string]int{"/health": 200, "/": 200, "/bar": 200} {
		rec := httptest.NewRecorder()
		srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != wantStatus {
			t.Fatalf("GET %s = %d, ожидался %d", path, rec.Code, wantStatus)
		}
	}
}

// Кнопка применяет переход, ответ несёт статус и состав.
func TestButtonMovesOrder(t *testing.T) {
	srv := newServer(t)

	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/bar/orders/o-1/start", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", rec.Code, rec.Body.String())
	}
	var moved struct {
		Status string `json:"status"`
		Items  []struct {
			Name string `json:"name"`
			Qty  int    `json:"qty"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &moved); err != nil {
		t.Fatal(err)
	}
	if moved.Status != "PREPARING" {
		t.Fatalf("статус после start: %s", moved.Status)
	}
	if len(moved.Items) != 1 || moved.Items[0].Name != "Попкорн солёный" {
		t.Fatalf("состав не приехал: %+v", moved.Items)
	}
}

// 404 нет такого заказа, 409 — переход не по циклу.
func TestButtonErrors(t *testing.T) {
	srv := newServer(t)

	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/bar/orders/no-such/ready", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("нет заказа = %d, ожидался 404", rec.Code)
	}

	// NEW: «выдан» пропускает шаги — конфликт
	rec = httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/bar/orders/o-1/pickup", nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("пропуск шагов = %d, ожидался 409", rec.Code)
	}
}

// Доска отдаёт колонки JSON-ом: new/preparing/ready/recent.
func TestBoardView(t *testing.T) {
	srv := newServer(t)
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/bar", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/bar = %d", rec.Code)
	}
	var board struct {
		New []struct {
			OrderID string `json:"orderId"`
			Session string `json:"session"`
		} `json:"new"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &board); err != nil {
		t.Fatal(err)
	}
	if len(board.New) != 1 || board.New[0].OrderID != "o-1" || board.New[0].Session != "без сеанса" {
		t.Fatalf("колонка new: %+v", board.New)
	}
}

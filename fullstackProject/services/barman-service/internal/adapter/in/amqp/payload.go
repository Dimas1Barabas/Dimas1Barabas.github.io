package amqp

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"barman-service/internal/domain"
)

// createdPayload — JSON события bar.order.created (контракт
// BarOrderCreatedEvent из NestJS API, camelCase как все обмены).
// sessionId/sessionAt/hall нулевые — заказ «без сеанса».
type createdPayload struct {
	OrderID      string `json:"orderId"`
	UserID       string `json:"userId"`
	CustomerName string `json:"customerName"`
	Email        string `json:"email"`
	SessionID    string `json:"sessionId"`
	SessionAt    string `json:"sessionAt"`
	Hall         string `json:"hall"`
	Items        []struct {
		ItemID   string `json:"itemId"`
		Name     string `json:"name"`
		PriceRub int    `json:"priceRub"`
		Qty      int    `json:"qty"`
	} `json:"items"`
	TotalRub  int    `json:"totalRub"`
	CreatedAt string `json:"createdAt"`
}

// cancelledPayload — JSON bar.order.cancelled.
type cancelledPayload struct {
	OrderID     string `json:"orderId"`
	CancelledAt string `json:"cancelledAt"`
}

// parseDelivery приводит доставку к use-case'у: created → *domain.Order,
// cancelled → orderID. Битый JSON, пустые ключи и неизвестный routing
// key — ошибки: консьюмер отличает poison от транзиентных сбоев.
func parseDelivery(d amqp091.Delivery) (*domain.Order, string, error) {
	switch d.RoutingKey {
	case keyCreated:
		return parseCreated(d)
	case keyCancelled:
		return parseCancelled(d)
	default:
		return nil, "", fmt.Errorf("неизвестный routing key %q", d.RoutingKey)
	}
}

func parseCreated(d amqp091.Delivery) (*domain.Order, string, error) {
	var p createdPayload
	if err := json.Unmarshal(d.Body, &p); err != nil {
		return nil, "", fmt.Errorf("не разбирается JSON: %w", err)
	}
	if p.OrderID == "" {
		return nil, "", errors.New("bar.order.created без orderId")
	}
	if len(p.Items) == 0 {
		return nil, "", errors.New("bar.order.created без позиций")
	}

	o := &domain.Order{
		OrderID:      p.OrderID,
		UserID:       p.UserID,
		Email:        p.Email,
		CustomerName: p.CustomerName,
		SessionID:    p.SessionID,
		Hall:         p.Hall,
		TotalRub:     p.TotalRub,
	}
	for _, it := range p.Items {
		o.Items = append(o.Items, domain.Item{
			ItemID: it.ItemID, Name: it.Name, PriceRub: it.PriceRub, Qty: it.Qty,
		})
	}
	var err error
	if o.SessionAt, err = parseTime(p.SessionAt); err != nil {
		return nil, "", fmt.Errorf("sessionAt заказа %s: %w", p.OrderID, err)
	}
	if o.CreatedAt, err = parseTime(p.CreatedAt); err != nil {
		return nil, "", fmt.Errorf("createdAt заказа %s: %w", p.OrderID, err)
	}
	return o, "", nil
}

func parseCancelled(d amqp091.Delivery) (*domain.Order, string, error) {
	var p cancelledPayload
	if err := json.Unmarshal(d.Body, &p); err != nil {
		return nil, "", fmt.Errorf("не разбирается JSON: %w", err)
	}
	if p.OrderID == "" {
		return nil, "", errors.New("bar.order.cancelled без orderId")
	}
	return nil, p.OrderID, nil
}

// parseTime: пустая строка — zero time (заказ без сеанса), иначе RFC3339.
func parseTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, err
	}
	return t, nil
}

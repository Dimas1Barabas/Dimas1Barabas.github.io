// Package amqp — исходящий адаптер: издатель событий bar.order.status
// в обмен cinema. Читают NestJS API (обновление bar_orders) и
// notification-service («письмо» о готовности). Retry-очередей у
// публикации нет: сбой доставки лечится повторным нажатием кнопки
// (use-case репаблишит уже применённый статус).
package amqp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/rabbitmq/amqp091-go"

	"barman-service/internal/adapter/out/prom"
	"barman-service/internal/domain"
	"barman-service/internal/tracing"
)

const (
	exchangeName = "cinema"
	// RoutingKey — ключ статусного события; PREPARING/READY/PICKED_UP.
	RoutingKey = "bar.order.status"
)

// statusPayload — JSON события (контракт BarOrderStatusEvent из NestJS
// API, camelCase). Email — адресат «письма» о готовности: событие
// читает notification-service только на READY, остальным статусам
// адресат не нужен, но едет всегда — контракт один.
type statusPayload struct {
	OrderID      string `json:"orderId"`
	Status       string `json:"status"`
	Email        string `json:"email"`
	CustomerName string `json:"customerName"`
	ChangedAt    string `json:"changedAt"`
}

// buildPayload собирает тело события; чистая функция — тестируется
// без брокера.
func buildPayload(o domain.Order) statusPayload {
	return statusPayload{
		OrderID:      o.OrderID,
		Status:       string(o.Status),
		Email:        o.Email,
		CustomerName: o.CustomerName,
		ChangedAt:    o.ChangedAt.Format(time.RFC3339),
	}
}

// Publisher держит одно соединение с брокером; канал спрятан за
// мьютексом, чтобы кнопки витрины публиковали concurrently с реконнектами.
type Publisher struct {
	url     string
	metrics *prom.Metrics
	mu      sync.Mutex
	conn    *amqp091.Connection
	channel *amqp091.Channel
}

func NewPublisher(url string, metrics *prom.Metrics) *Publisher {
	return &Publisher{url: url, metrics: metrics}
}

// Run держит соединение до отмены контекста; реконнект с бэкоффом —
// обязанность main (как у консьюмеров соседних сервисов). Обмен
// объявляется симметрично остальным сторонам: кто стартует первым,
// тот и создаёт.
func (p *Publisher) Run(ctx context.Context) error {
	conn, err := amqp091.Dial(p.url)
	if err != nil {
		return fmt.Errorf("подключение к RabbitMQ: %w", err)
	}
	// повторный Close уже закрытого соединения безвреден (ветка notifyClose)
	defer func() { _ = conn.Close() }()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("канал RabbitMQ: %w", err)
	}
	if err := ch.ExchangeDeclare(exchangeName, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("объявление обмена %s: %w", exchangeName, err)
	}

	p.mu.Lock()
	p.conn = conn
	p.channel = ch
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.channel = nil
		p.conn = nil
		p.mu.Unlock()
	}()

	notifyClose := conn.NotifyClose(make(chan *amqp091.Error, 1))
	select {
	case <-ctx.Done():
		_ = ch.Close()
		return nil // штатная остановка — не повод для реконнекта
	case err, ok := <-notifyClose:
		if ok && err != nil {
			return fmt.Errorf("соединение закрыто брокером: %w", err)
		}
		return errors.New("соединение с брокером закрыто")
	}
}

// PublishStatus — событие в обмен cinema. Persistent: сообщение
// переживает рестарт брокера в устойчивых очередях консьюмеров.
// PRODUCER-спан и traceparent — в tracing.PublishJSON: статус
// продолжает трейс нажатой кнопки экрана бара.
func (p *Publisher) PublishStatus(ctx context.Context, o domain.Order) error {
	body, err := json.Marshal(buildPayload(o))
	if err != nil {
		return fmt.Errorf("сборка payload статуса %s: %w", o.OrderID, err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.channel == nil {
		p.metrics.PublishFailed()
		return errors.New("соединение с брокером не установлено")
	}
	if err := tracing.PublishJSON(ctx, p.channel, exchangeName, RoutingKey, body); err != nil {
		p.metrics.PublishFailed()
		return err
	}
	p.metrics.Published(string(o.Status))
	return nil
}

var _ domain.StatusPublisher = (*Publisher)(nil)

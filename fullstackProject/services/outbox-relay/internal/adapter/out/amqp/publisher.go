// Package amqp — исходящий адаптер: издатель outbox-событий в обмен
// cinema. В отличие от reminder, routing key и заголовки — из записи:
// релей публикует ЧУЖОЕ событие, а не собирает своё. Retry-очередей нет —
// сбой публикации вернёт запись в pending, повторит следующий тик.
package amqp

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/rabbitmq/amqp091-go"

	"outbox-relay/internal/adapter/out/prom"
	"outbox-relay/internal/domain"
	"outbox-relay/internal/tracing"
)

const exchangeName = "cinema"

// Publisher держит одно соединение с брокером; канал спрятан за
// мьютексом, чтобы тикер публиковал concurrently с реконнектами.
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
// обязанность main (как у соседних сервисов). Обмен объявляется
// симметрично остальным сторонам: кто стартует первым, тот и создаёт.
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

// Publish — запись outbox в обмен cinema. Persistent: сообщение переживает
// рестарт брокера в устойчивых очередях консьюмеров. MessageId = id записи:
// дубль доставки (краш релея между publish и пометкой) консьюмеры гасят
// по нему. Трейс: родитель PRODUCER-спана — traceparent исходной операции
// из заголовков записи; консьюмерам уезжает свежий traceparent доставки.
func (p *Publisher) Publish(ctx context.Context, m domain.Message) error {
	// трейс-контекст и контекст отмены — разные роли: родитель спана —
	// traceparent исходной операции из заголовков записи, а прерывание
	// сети при остановке — по входному ctx тикера
	publishCtx, span := tracing.StartProducer(tracing.ExtractParent(m.Headers), m.RoutingKey)
	defer span.End()

	// свежая таблица доставки; сохранённые заголовки дозаполняют её,
	// не затирая traceparent доставки
	headers := tracing.InjectHeaders(publishCtx)
	for k, v := range m.Headers {
		if _, exists := headers[k]; !exists {
			headers[k] = v
		}
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.channel == nil {
		p.metrics.DeliveredError()
		return errors.New("соединение с брокером не установлено")
	}
	err := p.channel.PublishWithContext(ctx, exchangeName, m.RoutingKey, false, false, amqp091.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp091.Persistent,
		Timestamp:    m.CreatedAt,
		MessageId:    m.ID,
		Body:         m.Payload,
		Headers:      headers,
	})
	if err != nil {
		p.metrics.DeliveredError()
		return err
	}
	p.metrics.DeliveredOk()
	return nil
}

var _ domain.Publisher = (*Publisher)(nil)

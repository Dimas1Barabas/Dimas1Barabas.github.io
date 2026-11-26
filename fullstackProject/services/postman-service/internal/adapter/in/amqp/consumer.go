// Package amqp — входящий адаптер: слушает события жизненного цикла
// брони на обмене «cinema» — оплатили и создали (booking.created),
// вердикт саги (booking.processed), резерв истёк (booking.expired),
// возврат по отмене (booking.refunded). Всё это публикуют NestJS API
// и Go-воркер через транзакционный outbox. Топология и retry/parking —
// забота адаптера, домен о них не знает.
package amqp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"postman-service/internal/adapter/out/prom"
	"postman-service/internal/domain"
	"postman-service/internal/logging"
	"postman-service/internal/service"
	"postman-service/internal/tracing"
)

// События обмена «cinema», на которые подписан Почтальон.
const (
	keyCreated   = "booking.created"   // NestJS API: бронь оплачена и создана
	keyProcessed = "booking.processed" // Go-воркер: вердикт CONFIRMED/FAILED
	keyExpired   = "booking.expired"   // Go-воркер: резерв истёк без оплаты
	keyRefunded  = "booking.refunded"  // Go-воркер: вердикт возврата
)

const (
	retryHeader = "x-retry-count"
	queueName   = "postman.events"
)

// Consumer связывает очередь Почтальона с use-case'ом приёма события.
type Consumer struct {
	amqpURL string
	svc     *service.Postman
	metrics *prom.Metrics

	maxAttempts int
	retryTTLMs  int
}

// New — адаптер получает готовый use-case; кто за ним стоит, его не волнует.
func New(amqpURL string, svc *service.Postman, metrics *prom.Metrics, maxAttempts, retryTTLMs int) *Consumer {
	return &Consumer{amqpURL: amqpURL, svc: svc, metrics: metrics, maxAttempts: maxAttempts, retryTTLMs: retryTTLMs}
}

// Run держит одно подключение до отмены контекста; реконнект с бэкоффом —
// в main, как у соседних сервисов.
func (c *Consumer) Run(ctx context.Context) error {
	conn, err := amqp091.Dial(c.amqpURL)
	if err != nil {
		return fmt.Errorf("подключение к RabbitMQ: %w", err)
	}
	defer func() { _ = conn.Close() }()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("канал: %w", err)
	}
	defer func() { _ = ch.Close() }()

	if err := c.declareTopology(ch); err != nil {
		return err
	}
	// по одному сообщению за раз: fan-out на подписки — горсть вставок,
	// порядок не важен, спешить некуда
	if err := ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.Consume(queueName, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	logging.Infof(ctx, "postman слушает %s: %s", queueName, domain.EventTypes)

	for {
		select {
		case <-ctx.Done():
			return nil
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("канал закрыт, переподключаюсь")
			}
			c.handle(ch, d)
		}
	}
}

// handle: сообщение → use-case. Ядовитые события (битый JSON, чужой
// routing key — сюда не долетают, но paranoid) едут в parking без
// ретраев; собственные сбои (хранилище) — транзиентные, в retry-очередь
// с TTL: идемпотентность fan-out переживёт повтор.
func (c *Consumer) handle(ch *amqp091.Channel, d amqp091.Delivery) {
	// трейс продолжается из заголовков доставки (W3C traceparent)
	ctx, span := tracing.ConsumeSpan(d, queueName)
	defer span.End()

	evt := domain.Event{
		ID:         fingerprint(d.RoutingKey, d.Body),
		Type:       d.RoutingKey,
		Payload:    d.Body,
		ReceivedAt: time.Now(),
	}

	if err := c.svc.HandleEvent(ctx, evt); err != nil {
		if errors.Is(err, domain.ErrInvalidEvent) {
			logging.Errorf(ctx, "битое сообщение: %v", err)
			c.retryOrFail(ctx, ch, d, true, err.Error())
			return
		}
		// транзиентный сбой (хранилище) — ретраим
		c.metrics.Error()
		c.retryOrFail(ctx, ch, d, false, err.Error())
		return
	}
	c.metrics.Event(d.RoutingKey)
	_ = d.Ack(false)
}

// fingerprint — отпечаток события: sha256(routing key + тело). Ключ
// дедупликации доставок: ределивери брокера того же события даёт тот
// же отпечаток, повторных доставок партнёрам не заводится.
func fingerprint(routingKey string, body []byte) string {
	sum := sha256.Sum256(append([]byte(routingKey+"."), body...))
	return hex.EncodeToString(sum[:])
}

// declareTopology: обмен, наша очередь с биндами и retry/parking —
// зеркально топологии Бармена. Retry-очередь нужна на каждый
// routing key: её dead-letter-routing-key возвращает копию именно
// в этот поток, одна общая очередь сюда не годится.
func (c *Consumer) declareTopology(ch *amqp091.Channel) error {
	const exchange = "cinema"
	if err := ch.ExchangeDeclare(exchange, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("обмен %s: %w", exchange, err)
	}
	if _, err := ch.QueueDeclare(queueName, true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s: %w", queueName, err)
	}

	// одна парковка на все потоки — просто «радиационное хранилище»
	if _, err := ch.QueueDeclare(queueName+".parking", true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s.parking: %w", queueName, err)
	}

	for _, key := range domain.EventTypes {
		if err := ch.QueueBind(queueName, key, exchange, false, nil); err != nil {
			return fmt.Errorf("бинд %s на %s: %w", queueName, key, err)
		}

		retryArgs := amqp091.Table{
			"x-message-ttl":             c.retryTTLMs,
			"x-dead-letter-exchange":    exchange,
			"x-dead-letter-routing-key": key, // по TTL копия возвращается в свой поток
		}
		retryQ := queueName + "." + key + ".retry"
		if _, err := ch.QueueDeclare(retryQ, true, false, false, false, retryArgs); err != nil {
			return fmt.Errorf("очередь %s: %w", retryQ, err)
		}
		if err := ch.QueueBind(retryQ, key+".retry", exchange, false, nil); err != nil {
			return fmt.Errorf("бинд %s: %w", retryQ, err)
		}
		if err := ch.QueueBind(queueName+".parking", key+".parking", exchange, false, nil); err != nil {
			return fmt.Errorf("бинд parking на %s: %w", key, err)
		}
	}
	return nil
}

// retryOrFail публикует копию упавшего сообщения в `<rk>.retry`/`<rk>.parking`
// и подтверждает исходное; паузу между попытками делает брокер.
func (c *Consumer) retryOrFail(ctx context.Context, ch *amqp091.Channel, d amqp091.Delivery, poison bool, errText string) {
	tracing.MarkError(ctx, errors.New(errText))
	attempt := attempts(d) + 1
	target := "retry"
	if poison || attempt >= c.maxAttempts {
		target = "parking"
	}

	headers := amqp091.Table{}
	for k, v := range d.Headers {
		headers[k] = v
	}
	headers[retryHeader] = attempt
	headers["x-last-error"] = errText

	if err := ch.Publish("cinema", d.RoutingKey+"."+target, false, false, amqp091.Publishing{
		ContentType:  d.ContentType,
		DeliveryMode: amqp091.Persistent,
		Timestamp:    time.Now(),
		Body:         d.Body,
		Headers:      headers,
	}); err != nil {
		logging.Errorf(ctx, "↻ ! %s: %v", d.RoutingKey, err)
		return
	}
	_ = d.Ack(false)
	logging.Warnf(ctx, "↻ %s: попытка %d → %s (%s)", d.RoutingKey, attempt, target, errText)
}

// attempts читает счётчик попыток из заголовков; AMQP-типы целого
// зависят от брокера, поэтому всё int-семейство.
func attempts(d amqp091.Delivery) int {
	switch v := d.Headers[retryHeader].(type) {
	case int:
		return v
	case int16:
		return int(v)
	case int32:
		return int(v)
	case int64:
		return int(v)
	default:
		return 0
	}
}

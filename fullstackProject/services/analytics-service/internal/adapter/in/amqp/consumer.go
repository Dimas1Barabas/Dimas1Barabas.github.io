// Package amqp — входящий адаптер: слушает события поведения (инжест
// веба через API) и транзакционные события броней на обмене «cinema»,
// сводя их в агрегаты. Топология и retry/parking — забота адаптера,
// домен о них не знает.
package amqp

import (
	"context"
	"errors"
	"fmt"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"analytics-service/internal/adapter/out/prom"
	"analytics-service/internal/domain"
	"analytics-service/internal/logging"
	"analytics-service/internal/service"
	"analytics-service/internal/tracing"
)

// Потоки сервиса: события поведения публикует инжест API, события
// броней — API (оплачена) и Go-воркер (вердикт проведённого платежа).
const (
	keyAnalyticsEvent   = "analytics.event"
	keyBookingCreated   = "booking.created"
	keyBookingProcessed = "booking.processed"
)

// Две рабочие очереди: у событий веба и брокера разная природа
// (объём против важности), retry/parking — своя на очередь.
const (
	queueEvents    = "analytics.events"
	queueBookings  = "analytics.bookings"
	retryHeader    = "x-retry-count"
	parkingSuffix  = ".parking"
	retrySuffix    = ".retry"
	exchangeName   = "cinema"
)

// Consumer связывает очереди с анализатором.
type Consumer struct {
	amqpURL string
	svc     *service.Analyzer
	metrics *prom.Metrics

	maxAttempts int
	retryTTLMs  int
}

// New — адаптер получает готовый use-case; кто за ним стоит, его не волнует.
func New(amqpURL string, svc *service.Analyzer, metrics *prom.Metrics, maxAttempts, retryTTLMs int) *Consumer {
	return &Consumer{amqpURL: amqpURL, svc: svc, metrics: metrics, maxAttempts: maxAttempts, retryTTLMs: retryTTLMs}
}

// Run держит одно подключение до отмены контекста; реконнект с бэкоффом —
// в main, как у соседних сервисов. Обе очереди слушаются одним каналом:
// select по двум delivery-каналам сохраняет порядок внутри очереди.
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
	// по одному сообщению за раз: агрегаты — инкременты, порядок
	// между очередями не важен, спешить некуда
	if err := ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	web, err := ch.Consume(queueEvents, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %s: %w", queueEvents, err)
	}
	bookings, err := ch.Consume(queueBookings, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %s: %w", queueBookings, err)
	}

	logging.Infof(ctx, "analytics слушает %s / %s и %s / %s + %s",
		queueEvents, keyAnalyticsEvent, queueBookings, keyBookingCreated, keyBookingProcessed)

	for {
		select {
		case <-ctx.Done():
			return nil
		case d, ok := <-web:
			if !ok {
				return errors.New("канал событий закрыт, переподключаюсь")
			}
			c.handle(ch, d)
		case d, ok := <-bookings:
			if !ok {
				return errors.New("канал броней закрыт, переподключаюсь")
			}
			c.handle(ch, d)
		}
	}
}

// handle: сообщение → команда → агрегаты. Ядовитые сообщения (битый
// JSON, неизвестный routing key, провал инвариантов) едут в parking
// без ретраев; транзиентные (хранилище) — в retry-очередь с TTL.
func (c *Consumer) handle(ch *amqp091.Channel, d amqp091.Delivery) {
	// трейс продолжается из заголовков доставки (W3C traceparent)
	ctx, span := tracing.ConsumeSpan(d, queueOf(d.RoutingKey))
	defer span.End()

	cmd, err := decode(d)
	if err != nil {
		logging.Errorf(ctx, "битое сообщение: %v", err)
		c.retryOrFail(ctx, ch, d, true, err.Error())
		return
	}

	switch cmd.kind {
	case kindWeb:
		err = c.svc.HandleWebEvent(ctx, cmd.event)
	case kindPaid:
		err = c.svc.HandleBookingPaid(ctx, cmd.bookingID, cmd.movieID)
	case kindVerdict:
		err = c.svc.HandleBookingVerdict(ctx, cmd.bookingID, cmd.confirmed)
	}
	if err != nil {
		if errors.Is(err, domain.ErrInvalidEvent) {
			c.retryOrFail(ctx, ch, d, true, err.Error())
			return
		}
		// собственный сбой (хранилище) — транзиентный, ретраим
		c.metrics.Error()
		c.retryOrFail(ctx, ch, d, false, err.Error())
		return
	}
	c.metrics.Event(d.RoutingKey)
	_ = d.Ack(false)
}

// queueOf сопоставляет routing key рабочей очереди — для спанов и логов.
func queueOf(routingKey string) string {
	if routingKey == keyAnalyticsEvent {
		return queueEvents
	}
	return queueBookings
}

// declareTopology: обмен, две рабочие очереди, retry на каждый routing
// key и parking на каждую очередь — зеркально топологии Тарификатора.
// Retry-очередь нужна на каждый rk: её dead-letter-routing-key возвращает
// копию именно в этот поток.
func (c *Consumer) declareTopology(ch *amqp091.Channel) error {
	if err := ch.ExchangeDeclare(exchangeName, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("обмен %s: %w", exchangeName, err)
	}

	queues := map[string][]string{
		queueEvents:   {keyAnalyticsEvent},
		queueBookings: {keyBookingCreated, keyBookingProcessed},
	}
	for queue, keys := range queues {
		if _, err := ch.QueueDeclare(queue, true, false, false, false, nil); err != nil {
			return fmt.Errorf("очередь %s: %w", queue, err)
		}
		// парковка на очередь — «радиационное хранилище» потока
		if _, err := ch.QueueDeclare(queue+parkingSuffix, true, false, false, false, nil); err != nil {
			return fmt.Errorf("очередь %s%s: %w", queue, parkingSuffix, err)
		}

		for _, key := range keys {
			if err := ch.QueueBind(queue, key, exchangeName, false, nil); err != nil {
				return fmt.Errorf("бинд %s на %s: %w", queue, key, err)
			}
			if err := ch.QueueBind(queue+parkingSuffix, key+parkingSuffix, exchangeName, false, nil); err != nil {
				return fmt.Errorf("бинд parking %s на %s: %w", queue, key, err)
			}
			retryArgs := amqp091.Table{
				"x-message-ttl":             c.retryTTLMs,
				"x-dead-letter-exchange":    exchangeName,
				"x-dead-letter-routing-key": key, // по TTL копия возвращается в свой поток
			}
			retryQ := queue + "." + key + retrySuffix
			if _, err := ch.QueueDeclare(retryQ, true, false, false, false, retryArgs); err != nil {
				return fmt.Errorf("очередь %s: %w", retryQ, err)
			}
			if err := ch.QueueBind(retryQ, key+retrySuffix, exchangeName, false, nil); err != nil {
				return fmt.Errorf("бинд %s: %w", retryQ, err)
			}
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

	if err := ch.Publish(exchangeName, d.RoutingKey+"."+target, false, false, amqp091.Publishing{
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

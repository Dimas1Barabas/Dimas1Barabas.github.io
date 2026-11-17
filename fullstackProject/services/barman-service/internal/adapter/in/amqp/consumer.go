// Package amqp — входящий адаптер: слушает события кинобара на обмене
// «cinema» — заказ оформлен (bar.order.created) и отменён владельцем
// (bar.order.cancelled), оба публикует NestJS API через Курьера.
// Топология и retry/parking — забота адаптера, домен о них не знает.
package amqp

import (
	"context"
	"errors"
	"fmt"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"barman-service/internal/adapter/out/prom"
	"barman-service/internal/domain"
	"barman-service/internal/logging"
	"barman-service/internal/service"
	"barman-service/internal/tracing"
)

// События обмена «cinema», на которые подписан Бармен.
const (
	keyCreated   = "bar.order.created"   // NestJS API: заказ оформлен
	keyCancelled = "bar.order.cancelled" // NestJS API: владелец отменил
)

const (
	retryHeader = "x-retry-count"
	queueName   = "barman.orders"
)

// Consumer связывает очередь Бармена с use-case'ами приёма и отмены.
type Consumer struct {
	amqpURL string
	svc     *service.Barman
	metrics *prom.Metrics

	maxAttempts int
	retryTTLMs  int
}

// New — адаптер получает готовые use-cases; кто за ними стоит, его не волнует.
func New(amqpURL string, svc *service.Barman, metrics *prom.Metrics, maxAttempts, retryTTLMs int) *Consumer {
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
	// по одному сообщению за раз: приём заказа — одна вставка, спешить
	// некуда, порядок в колонке NEW — порядок прихода событий
	if err := ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.Consume(queueName, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	logging.Infof(ctx, "barman слушает %s / %s + %s", queueName, keyCreated, keyCancelled)

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

// handle: сообщение → use-case. Ядовитые события (битый JSON, неизвестный
// routing key) едут в parking без ретраев; собственные сбои (хранилище,
// публикация) — транзиентные, в retry-очередь с TTL.
func (c *Consumer) handle(ch *amqp091.Channel, d amqp091.Delivery) {
	// трейс продолжается из заголовков доставки (W3C traceparent)
	ctx, span := tracing.ConsumeSpan(d, queueName)
	defer span.End()

	order, cancelID, err := parseDelivery(d)
	if err != nil {
		logging.Errorf(ctx, "битое сообщение: %v", err)
		c.retryOrFail(ctx, ch, d, true, err.Error())
		return
	}

	var applyErr error
	if order != nil {
		applyErr = c.svc.Accept(ctx, *order)
	} else {
		applyErr = c.svc.Cancel(ctx, cancelID)
	}
	if applyErr != nil {
		if errors.Is(applyErr, domain.ErrInvalidOrderEvent) {
			c.retryOrFail(ctx, ch, d, true, applyErr.Error())
			return
		}
		// транзиентный сбой (хранилище/брокер) — ретраим
		c.metrics.Error()
		c.retryOrFail(ctx, ch, d, false, applyErr.Error())
		return
	}
	c.metrics.Accepted(d.RoutingKey)
	_ = d.Ack(false)
}

// declareTopology: обмен, наша очередь с двумя биндами и retry/parking —
// зеркально топологии Тарификатора. Retry-очередь нужна на каждый
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

	for _, key := range []string{keyCreated, keyCancelled} {
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

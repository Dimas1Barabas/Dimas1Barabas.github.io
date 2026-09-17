// Package amqp — входящий адаптер: слушает вердикты воркера на обмене
// «cinema» и передаёт их use-case'у. Топология и retry/parking — забота
// адаптера, домен о них не знает.
package amqp

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	amqp091 "github.com/rabbitmq/amqp091-go"

	"notification-service/internal/domain"
	"notification-service/internal/service"
)

// События обмена «cinema», на которые подписан сервис. Контракт общий
// с NestJS и ticket-worker; сюда приходят только вердикты — то, что
// клиент должен увидеть.
const (
	keyProcessed = "booking.processed" // воркер: CONFIRMED | FAILED
	keyRefunded  = "booking.refunded"  // воркер: CANCELLED | REFUND_FAILED
	keyExpired   = "booking.expired"   // воркер: резерв истёк
)

const (
	retryHeader = "x-retry-count"
	queueName   = "notification.events"
)

// Consumer связывает очередь вердиктов со сценарием уведомлений.
type Consumer struct {
	amqpURL string
	svc     *service.Notifier

	maxAttempts int
	retryTTLMs  int
}

// New — адаптер получает готовый use-case; кто за ним стоит, его не волнует.
func New(amqpURL string, svc *service.Notifier, maxAttempts, retryTTLMs int) *Consumer {
	return &Consumer{amqpURL: amqpURL, svc: svc, maxAttempts: maxAttempts, retryTTLMs: retryTTLMs}
}

// Run держит одно подключение до отмены контекста; реконнект с бэкоффом —
// в main, как у ticket-worker.
func (c *Consumer) Run(ctx context.Context) error {
	conn, err := amqp091.Dial(c.amqpURL)
	if err != nil {
		return fmt.Errorf("подключение к RabbitMQ: %w", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("канал: %w", err)
	}
	defer ch.Close()

	if err := c.declareTopology(ch); err != nil {
		return err
	}
	// по одному сообщению за раз: доставка «почты» не перегружает сервис
	if err := ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.Consume(queueName, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	log.Printf("notification слушает %s / booking.processed + booking.refunded + booking.expired", queueName)

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

// handle: сообщение → доменный вердикт → сценарий. Ядовитые события
// (битый JSON, неизвестный routing key или вердикт) едут в parking
// без ретраев; транзиентные — в retry-очередь с TTL.
func (c *Consumer) handle(ch *amqp091.Channel, d amqp091.Delivery) {
	outcome, err := toOutcome(d)
	if err != nil {
		log.Printf("битое сообщение: %v", err)
		c.retryOrFail(ch, d, true, err.Error())
		return
	}

	if err := c.svc.HandleOutcome(context.Background(), outcome); err != nil {
		if errors.Is(err, domain.ErrUnknownVerdict) {
			c.retryOrFail(ch, d, true, err.Error())
			return
		}
		// собственный сбой (хранилище) — транзиентный, ретраим
		c.retryOrFail(ch, d, false, err.Error())
		return
	}
	_ = d.Ack(false)
}

// declareTopology: обмен, наша очередь с тремя биндами и retry/parking —
// зеркально топологии ticket-worker. Retry-очередь нужна на каждый
// routing key: её dead-letter-routing-key возвращает копию именно в этот
// поток, одна общая очередь сюда не годится.
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

	for _, key := range []string{keyProcessed, keyRefunded, keyExpired} {
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
func (c *Consumer) retryOrFail(ch *amqp091.Channel, d amqp091.Delivery, poison bool, errText string) {
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
		log.Printf("↻ ! %s: %v", d.RoutingKey, err)
		return
	}
	_ = d.Ack(false)
	log.Printf("↻ %s: попытка %d → %s (%s)", d.RoutingKey, attempt, target, errText)
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

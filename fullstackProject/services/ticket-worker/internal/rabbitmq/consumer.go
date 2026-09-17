// Package rabbitmq — консьюмер воркера: подключение к брокеру, топология
// очередей, разводка потоков по routing key и retry/parking упавших
// сообщений.
package rabbitmq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"ticket-worker/internal/config"
	"ticket-worker/internal/events"
	"ticket-worker/internal/processing"
	"ticket-worker/internal/stats"
)

// Consumer связывает очереди воркера с обработчиком-«шлюзом».
type Consumer struct {
	cfg   config.Config
	proc  *processing.Processor
	stats *stats.Stats
}

// New собирает консьюмера: зависимости приходят снаружи, пакет ничего
// не создаёт сам.
func New(cfg config.Config, proc *processing.Processor, st *stats.Stats) *Consumer {
	return &Consumer{cfg: cfg, proc: proc, stats: st}
}

// Run держит одно подключение к брокеру до отмены контекста. При обрыве
// канала возвращает ошибку — цикл реконнекта с бэкоффом живёт в main.
func (c *Consumer) Run(ctx context.Context) error {
	conn, err := amqp.Dial(c.cfg.AMQPURL)
	if err != nil {
		return fmt.Errorf("подключение к RabbitMQ: %w", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("канал: %w", err)
	}
	defer ch.Close()

	if err := declareTopology(ch, c.cfg); err != nil {
		return err
	}
	// Берём по одному сообщению за раз — «честная» обработка без перегрузки.
	if err := ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.Consume(c.cfg.InQueue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}
	refunds, err := ch.Consume(c.cfg.CancelQueue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %s: %w", c.cfg.CancelQueue, err)
	}
	expired, err := ch.Consume(c.cfg.ExpireQueue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %s: %w", c.cfg.ExpireQueue, err)
	}

	log.Printf("воркер %s слушает %s / booking.created + booking.cancelled + booking.payment.timeout",
		c.cfg.WorkerID, c.cfg.InQueue)

	for {
		select {
		case <-ctx.Done():
			return nil
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("канал закрыт, переподключаюсь")
			}
			c.handleDelivery(ch, d)
		case d, ok := <-refunds:
			if !ok {
				return errors.New("канал закрыт, переподключаюсь")
			}
			c.handleDelivery(ch, d)
		case d, ok := <-expired:
			if !ok {
				return errors.New("канал закрыт, переподключаюсь")
			}
			c.handleDelivery(ch, d)
		}
	}
}

// handleDelivery разводит потоки по routing key: оплата, возврат или истечение.
func (c *Consumer) handleDelivery(ch *amqp.Channel, d amqp.Delivery) {
	switch d.RoutingKey {
	case events.KeyCreated:
		c.handleCreated(ch, d)
	case events.KeyCancelled:
		c.handleCancelled(ch, d)
	case events.KeyPaymentTimeout:
		c.handlePaymentTimeout(ch, d)
	default:
		log.Printf("неизвестный routing key %q", d.RoutingKey)
		c.stats.Errors.Add(1)
		// poison: ретраить бессмысленно — сразу в parking
		c.retryOrFail(ch, d, true, "неизвестный routing key "+d.RoutingKey)
	}
}

func (c *Consumer) handleCreated(ch *amqp.Channel, d amqp.Delivery) {
	c.stats.Received.Add(1)

	var ev events.BookingCreated
	if err := json.Unmarshal(d.Body, &ev); err != nil {
		log.Printf("битое сообщение: %v", err)
		c.stats.Errors.Add(1)
		// poison: тело не разбирается, ретраи не помогут — в parking
		c.retryOrFail(ch, d, true, fmt.Sprintf("не разбирается JSON: %v", err))
		return
	}

	log.Printf("← %s: «%s», места %s, %d ₽",
		ev.BookingID, ev.MovieTitle, strings.Join(ev.Seats, ", "), ev.TotalRub)

	result := c.proc.Process(ev)
	body, err := json.Marshal(result)
	if err != nil {
		c.stats.Errors.Add(1)
		c.retryOrFail(ch, d, false, fmt.Sprintf("не сериализуется вердикт: %v", err))
		return
	}

	if err := publishJSON(ch, c.cfg.Exchange, events.KeyProcessed, body); err != nil {
		log.Printf("→ ! %s: %v", ev.BookingID, err)
		c.stats.Errors.Add(1)
		c.retryOrFail(ch, d, false, fmt.Sprintf("публикация вердикта: %v", err))
		return
	}

	_ = d.Ack(false)
	if result.Status == "CONFIRMED" {
		c.stats.Confirmed.Add(1)
	} else {
		c.stats.Failed.Add(1)
	}
	log.Printf("→ %s: %s — %s", ev.BookingID, result.Status, result.Message)
}

func (c *Consumer) handleCancelled(ch *amqp.Channel, d amqp.Delivery) {
	c.stats.Received.Add(1)

	var ev events.BookingCancelled
	if err := json.Unmarshal(d.Body, &ev); err != nil {
		log.Printf("битое сообщение: %v", err)
		c.stats.Errors.Add(1)
		c.retryOrFail(ch, d, true, fmt.Sprintf("не разбирается JSON: %v", err))
		return
	}

	log.Printf("← возврат %s: «%s», места %s, %d ₽",
		ev.BookingID, ev.MovieTitle, strings.Join(ev.Seats, ", "), ev.TotalRub)

	result := c.proc.Refund(ev)
	body, err := json.Marshal(result)
	if err != nil {
		c.stats.Errors.Add(1)
		c.retryOrFail(ch, d, false, fmt.Sprintf("не сериализуется вердикт: %v", err))
		return
	}

	if err := publishJSON(ch, c.cfg.Exchange, events.KeyRefunded, body); err != nil {
		log.Printf("→ ! %s: %v", ev.BookingID, err)
		c.stats.Errors.Add(1)
		c.retryOrFail(ch, d, false, fmt.Sprintf("публикация вердикта: %v", err))
		return
	}

	_ = d.Ack(false)
	if result.Status == "CANCELLED" {
		c.stats.Refunds.Add(1)
	} else {
		c.stats.RefundFailed.Add(1)
	}
	log.Printf("→ %s: %s — %s", ev.BookingID, result.Status, result.Message)
}

// handlePaymentTimeout гасит просроченный резерв: сообщение уже прождало
// окно оплаты в wait-очереди, вердикт уходит без задержки. Идемпотентность
// на стороне API: оплаченная/отменённая бронь вердикт молча пропустит.
func (c *Consumer) handlePaymentTimeout(ch *amqp.Channel, d amqp.Delivery) {
	c.stats.Received.Add(1)

	var ev events.BookingPaymentTimeout
	if err := json.Unmarshal(d.Body, &ev); err != nil {
		log.Printf("битое сообщение: %v", err)
		c.stats.Errors.Add(1)
		// poison: тело не разбирается, ретраи не помогут — в parking
		c.retryOrFail(ch, d, true, fmt.Sprintf("не разбирается JSON: %v", err))
		return
	}

	log.Printf("← таймаут %s: окно оплаты истекло", ev.BookingID)

	result := c.proc.Expired(ev, time.Now())
	body, err := json.Marshal(result)
	if err != nil {
		c.stats.Errors.Add(1)
		c.retryOrFail(ch, d, false, fmt.Sprintf("не сериализуется вердикт: %v", err))
		return
	}

	if err := publishJSON(ch, c.cfg.Exchange, events.KeyExpired, body); err != nil {
		log.Printf("→ ! %s: %v", ev.BookingID, err)
		c.stats.Errors.Add(1)
		c.retryOrFail(ch, d, false, fmt.Sprintf("публикация вердикта: %v", err))
		return
	}

	_ = d.Ack(false)
	c.stats.Expired.Add(1)
	log.Printf("→ %s: EXPIRED — %s", ev.BookingID, result.Message)
}

// retryOrFail публикует копию упавшего сообщения в `<rk>.retry` или
// `<rk>.parking` и подтверждает исходное. Паузу между попытками делает
// брокер: retry-очередь держит копию TTL и по dead-letter возвращает её
// в рабочую очередь.
func (c *Consumer) retryOrFail(ch *amqp.Channel, d amqp.Delivery, poison bool, errText string) {
	attempt := attempts(d) + 1
	target := routeFor(attempt, c.cfg.MaxAttempts, poison)

	headers := amqp.Table{}
	for k, v := range d.Headers {
		headers[k] = v
	}
	headers[retryHeader] = attempt
	headers["x-last-error"] = errText

	if err := ch.Publish(c.cfg.Exchange, d.RoutingKey+"."+target, false, false,
		amqp.Publishing{
			ContentType:  d.ContentType,
			DeliveryMode: amqp.Persistent,
			Timestamp:    time.Now(),
			Body:         d.Body,
			Headers:      headers,
		}); err != nil {
		// канал, скорее всего, мёртв: не ack'аем — брокер вернёт сообщение
		log.Printf("↻ ! %s: %v", d.RoutingKey, err)
		return
	}
	_ = d.Ack(false)
	log.Printf("↻ %s: попытка %d → %s (%s)", d.RoutingKey, attempt, target, errText)
}

// publishJSON отправляет событие в обмен «cinema» персистентно.
func publishJSON(ch *amqp.Channel, exchange, rk string, body []byte) error {
	return ch.Publish(exchange, rk, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
		Body:         body,
	})
}

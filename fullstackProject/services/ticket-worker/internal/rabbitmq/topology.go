package rabbitmq

import (
	"fmt"

	amqp "github.com/rabbitmq/amqp091-go"

	"ticket-worker/internal/config"
	"ticket-worker/internal/events"
)

// declareTopology объявляет всё, что нужно воркеру на брокере: обмен,
// три рабочие очереди и retry/parking-топологию над каждой. Идемпотентно —
// можно звать после каждого реконнекта.
func declareTopology(ch *amqp.Channel, cfg config.Config) error {
	// Тот же topic-обмен, что объявляет NestJS API — параметры идентичны.
	if err := ch.ExchangeDeclare(cfg.Exchange, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("обмен %s: %w", cfg.Exchange, err)
	}
	if _, err := ch.QueueDeclare(cfg.InQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s: %w", cfg.InQueue, err)
	}
	if err := ch.QueueBind(cfg.InQueue, events.KeyCreated, cfg.Exchange, false, nil); err != nil {
		return fmt.Errorf("бинд %s: %w", cfg.InQueue, err)
	}
	// Вторая очередь — запросы возврата из саги отмены брони.
	if _, err := ch.QueueDeclare(cfg.CancelQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s: %w", cfg.CancelQueue, err)
	}
	if err := ch.QueueBind(cfg.CancelQueue, events.KeyCancelled, cfg.Exchange, false, nil); err != nil {
		return fmt.Errorf("бинд %s: %w", cfg.CancelQueue, err)
	}
	// Третья очередь — истёкшие резервы: их присылает dead-letter'ом
	// wait-очередь API (TTL окна оплаты), сам API её не декларирует.
	if _, err := ch.QueueDeclare(cfg.ExpireQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s: %w", cfg.ExpireQueue, err)
	}
	if err := ch.QueueBind(cfg.ExpireQueue, events.KeyPaymentTimeout, cfg.Exchange, false, nil); err != nil {
		return fmt.Errorf("бинд %s: %w", cfg.ExpireQueue, err)
	}
	// Топология надёжности: retry-очереди (TTL + возврат в рабочую) и
	// parking — зеркально той, что объявляет NestJS API.
	queues := []struct{ queue, key string }{
		{cfg.InQueue, events.KeyCreated},
		{cfg.CancelQueue, events.KeyCancelled},
		{cfg.ExpireQueue, events.KeyPaymentTimeout},
	}
	for _, q := range queues {
		if err := declareRetryTopology(ch, cfg.Exchange, q.queue, q.key, cfg.RetryTTLMs); err != nil {
			return err
		}
	}
	return nil
}

// declareRetryTopology объявляет `<queue>.retry` (держит упавшее сообщение
// ttlMs и по dead-letter возвращает его в рабочую очередь) и `<queue>.parking`
// — «парковку» ядовитых и исчерпавших попытки сообщений.
func declareRetryTopology(ch *amqp.Channel, exchange, queue, routingKey string, ttlMs int) error {
	retryArgs := amqp.Table{
		"x-message-ttl":             ttlMs,
		"x-dead-letter-exchange":    exchange,
		"x-dead-letter-routing-key": routingKey,
	}
	if _, err := ch.QueueDeclare(queue+".retry", true, false, false, false, retryArgs); err != nil {
		return fmt.Errorf("очередь %s.retry: %w", queue, err)
	}
	if err := ch.QueueBind(queue+".retry", routingKey+".retry", exchange, false, nil); err != nil {
		return fmt.Errorf("бинд %s.retry: %w", queue, err)
	}
	if _, err := ch.QueueDeclare(queue+".parking", true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s.parking: %w", queue, err)
	}
	if err := ch.QueueBind(queue+".parking", routingKey+".parking", exchange, false, nil); err != nil {
		return fmt.Errorf("бинд %s.parking: %w", queue, err)
	}
	return nil
}

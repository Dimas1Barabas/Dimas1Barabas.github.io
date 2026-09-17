package rabbitmq

import (
	amqp "github.com/rabbitmq/amqp091-go"
)

// retryHeader — счётчик попыток; растёт с каждым уходом в retry-очередь.
const retryHeader = "x-retry-count"

// attempts читает счётчик попыток из заголовков доставки (0 — оригинал).
// AMQP-типы целого зависят от брокера, поэтому принимаем всё int-семейство.
func attempts(d amqp.Delivery) int {
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

// routeFor решает судьбу упавшего сообщения: транзиентная ошибка ретраится,
// пока попыток меньше max; «ядовитое» (poison) едет в parking сразу —
// ретраи его не исправят.
func routeFor(attempt, max int, poison bool) string {
	if poison || attempt >= max {
		return "parking"
	}
	return "retry"
}

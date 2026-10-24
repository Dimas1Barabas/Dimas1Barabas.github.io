// Перенос трейс-контекста через RabbitMQ: заголовки Publishing — тот же
// W3C traceparent, что и в HTTP, просто едет он в properties.headers.
// У Курьера два источника заголовков: сохранённые в outbox (родитель) и
// свежесозданный PRODUCER-спан доставки (уходит консьюмерам).
package tracing

import (
	"context"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// rabbitTracer резолвит трейсер от ТЕКУЩЕГО глобального провайдера на каждый
// вызов: package var с otel.Tracer прибивается к первому делегату и не
// следует повторным SetTracerProvider — важно для тестов, где провайдер
// свой на каждый кейс.
func rabbitTracer() trace.Tracer {
	return otel.Tracer("cine-booking/rabbit")
}

// tableCarrier адаптирует amqp.Table под propagation.TextMapCarrier
// (Table — map-тип, конверсия поверх той же памяти).
type tableCarrier amqp.Table

func (t tableCarrier) Get(key string) string {
	if v, ok := t[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func (t tableCarrier) Set(key, value string) { t[key] = value }

func (t tableCarrier) Keys() []string {
	keys := make([]string, 0, len(t))
	for k := range t {
		keys = append(keys, k)
	}
	return keys
}

// mapCarrier — то же для map[string]string (заголовки outbox-записи).
type mapCarrier map[string]string

func (m mapCarrier) Get(key string) string { return m[key] }

func (m mapCarrier) Set(key, value string) { m[key] = value }

func (m mapCarrier) Keys() []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// ExtractParent восстанавливает контекст трейса из сохранённых заголовков
// outbox-записи: traceparent исходной операции — родитель доставки. Без
// пропагатора/заголовков вернётся пустой контекст — корневой спан.
func ExtractParent(headers map[string]string) context.Context {
	return otel.GetTextMapPropagator().Extract(context.Background(), mapCarrier(headers))
}

// InjectHeaders пишет W3C traceparent активного контекста в новую таблицу
// заголовков. Без зарегистрированного пропагатора таблица пуста — публикация
// едет как раньше.
func InjectHeaders(ctx context.Context) amqp.Table {
	headers := amqp.Table{}
	otel.GetTextMapPropagator().Inject(ctx, tableCarrier(headers))
	return headers
}

// StartProducer открывает PRODUCER-спан доставки (родитель — что дали
// в ctx, у Курьера обычно ExtractParent).
func StartProducer(ctx context.Context, rk string) (context.Context, trace.Span) {
	return rabbitTracer().Start(ctx, "rabbit.publish "+rk,
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.rabbitmq.routing_key", rk),
		),
	)
}

// Перенос трейс-контекста через RabbitMQ: заголовки Publishing/Delivery —
// тот же W3C traceparent, что и в HTTP, просто едет он в properties.headers.
package tracing

import (
	"context"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
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

// PublishJSON публикует событие в обмен, продолжая активный трейс:
// PRODUCER-спан + traceparent в заголовках сообщения.
func PublishJSON(ctx context.Context, ch *amqp.Channel, exchange, rk string, body []byte) error {
	ctx, span := rabbitTracer().Start(ctx, "rabbit.publish "+rk,
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination.name", exchange),
			attribute.String("messaging.rabbitmq.routing_key", rk),
		),
	)
	defer span.End()

	err := ch.Publish(exchange, rk, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
		Body:         body,
		Headers:      InjectHeaders(ctx),
	})
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	return err
}

// InjectHeaders пишет W3C traceparent активного контекста в новую таблицу
// заголовков. Без зарегистрированного пропагатора таблица пуста — публикация
// едет как раньше.
func InjectHeaders(ctx context.Context) amqp.Table {
	headers := amqp.Table{}
	otel.GetTextMapPropagator().Inject(ctx, tableCarrier(headers))
	return headers
}

// ConsumeSpan извлекает родителя из заголовков доставки и создаёт
// CONSUMER-спан; вызывающий обязан сделать span.End().
func ConsumeSpan(d amqp.Delivery, queue string) (context.Context, trace.Span) {
	ctx := otel.GetTextMapPropagator().Extract(context.Background(), tableCarrier(d.Headers))
	return rabbitTracer().Start(ctx, "rabbit.consume "+d.RoutingKey,
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.destination.name", queue),
			attribute.String("messaging.rabbitmq.routing_key", d.RoutingKey),
		),
	)
}

// MarkError фиксирует ошибку обработки в спане из ctx (не роняет ничего,
// если трейсинга нет — no-op спаны не пишут).
func MarkError(ctx context.Context, err error) {
	if span := trace.SpanFromContext(ctx); span.IsRecording() {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
}

// StartProducer открывает PRODUCER-спан для публикации с кастомной обёрткой
// вокруг channel (метрики, мьютексы): заголовки потом возьмёт InjectHeaders.
func StartProducer(ctx context.Context, rk string) (context.Context, trace.Span) {
	return rabbitTracer().Start(ctx, "rabbit.publish "+rk,
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", "rabbitmq"),
			attribute.String("messaging.rabbitmq.routing_key", rk),
		),
	)
}

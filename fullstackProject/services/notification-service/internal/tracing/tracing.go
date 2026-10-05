// Package tracing — OpenTelemetry для notification-service: TracerProvider с OTLP-экспортером
// (gRPC :4317 → Jaeger) и перенос W3C traceparent через заголовки сообщений
// RabbitMQ. Консьюмер продолжает трейс публикатора, публикация — активный
// трейс сервиса.
//
// Без переменной OTEL_EXPORTER_OTLP_ENDPOINT трейсинга нет вовсе: глобальный
// TracerProvider остаётся no-op, заголовки не пишутся и не читаются
// (юнит-тесты, CI-e2e без observability) — поведение кода не меняется.
package tracing

import (
	"context"
	"log"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Setup регистрирует глобальный TracerProvider и W3C-пропагатор. Возвращает
// shutdown — вызывающий обязан вызвать его при остановке (сбросит батчер).
// Гейт по env сделан сознательно: экспортер в никуда ретраился бы с логами.
func Setup(serviceName string) (shutdown func(context.Context) error) {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		return func(context.Context) error { return nil }
	}

	ctx := context.Background()
	exporter, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		// стенд внутри docker-сети — TLS нет
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		log.Printf("tracing: OTLP-экспортер не собрался: %v", err)
		return func(context.Context) error { return nil }
	}

	res, err := resource.Merge(
		resource.Default(),
		resource.NewSchemaless(semconv.ServiceName(serviceName)),
	)
	if err != nil {
		log.Printf("tracing: ресурс не собрался: %v", err)
		return func(context.Context) error { return nil }
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	// глобальный пропагатор Go по умолчанию no-op — W3C ставим сами
	otel.SetTextMapPropagator(propagation.TraceContext{})
	log.Printf("tracing: OTLP → %s (%s)", endpoint, serviceName)
	return tp.Shutdown
}

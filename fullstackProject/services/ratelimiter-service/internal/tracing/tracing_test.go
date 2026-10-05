package tracing

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// У rate-limiter нет брокера — здесь только каркас: гейт по env и
// безвредный shutdown. AMQP-перенос трейс-контекста живёт в пакетах
// сервисов, у которых есть консьюмеры/паблишеры.
func TestSetupWithoutEndpoint(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	shutdown := Setup("ratelimiter")
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown вернул ошибку: %v", err)
	}
}

func TestSetupWithEndpoint(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "localhost:4317")
	shutdown := Setup("spec")

	// провайдер зарегистрирован: спан валидный (не no-op)…
	ctx, span := otel.Tracer("spec").Start(context.Background(), "warm")
	if !span.SpanContext().IsValid() {
		t.Fatal("спан no-op — глобальный провайдер не поднялся")
	}
	// …и пропагатор W3C: traceparent пишется в заголовки
	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(trace.ContextWithSpan(ctx, span), carrier)
	if carrier.Get("traceparent") == "" {
		t.Fatal("глобальный пропагатор не W3C — traceparent не записан")
	}
	// спан НЕ закрываем: батчер пуст, shutdown без попытки экспорта
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown вернул ошибку: %v", err)
	}
}

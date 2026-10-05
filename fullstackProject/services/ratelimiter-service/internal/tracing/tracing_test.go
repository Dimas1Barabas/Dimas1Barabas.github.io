package tracing

import (
	"context"
	"testing"
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

// analytics-service («Аналитик») — микросервис на Go: копит поведенческую
// статистику киносеансов из двух потоков RabbitMQ — события поведения
// с веба (инжест через NestJS API: страницы, воронка бронирования,
// клики по местам) и транзакционные события броней (booking.created /
// booking.processed) — и отдаёт витрину «Поведение» одним ответом:
// что чаще смотрят и бронируют, где застревают, сколько времени
// проводят на шагах.
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, RabbitMQ/HTTP/память/
// Postgres — заменяемые адаптеры на периферии. gRPC не нужен: сервис
// никого не спрашивает синхронно, только слушает и отвечает витриной.
package main

import (
	"context"
	"os/signal"
	"syscall"
	"time"

	"analytics-service/internal/adapter/in/amqp"
	"analytics-service/internal/adapter/in/httpapi"
	"analytics-service/internal/adapter/out/memory"
	"analytics-service/internal/adapter/out/postgres"
	"analytics-service/internal/adapter/out/prom"
	"analytics-service/internal/config"
	"analytics-service/internal/domain"
	"analytics-service/internal/logging"
	"analytics-service/internal/service"
	"analytics-service/internal/tracing"
)

func main() {
	// JSON-логи ДО трейсинга: диагностика tracing.Setup тоже уходит JSON'ом
	logging.Setup()
	cfg := config.Load()

	// wiring: за портом AnalyticsStore стоит конкретный адаптер; домен
	// и service о них не знают. Хранилище выбирает composition root
	// по STORAGE: память (дефолт — стенд без БД не падает) или Postgres
	// со своей базой, которую адаптер создаёт сам.
	var store domain.AnalyticsStore
	switch cfg.Storage {
	case "memory":
		store = memory.NewStore()
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю статистики
		pgStore, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			logging.Fatalf("STORAGE=postgres: %v", err)
		}
		defer func() { _ = pgStore.Close() }()
		store = pgStore
	default:
		logging.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}

	analyzer := service.NewAnalyzer(store)
	// счётчики событий/сбоев — на границе amqp-адаптера
	metrics := prom.New()
	consumer := amqp.New(cfg.AMQPURL, analyzer, metrics, cfg.MaxAttempts, cfg.RetryTTLMs)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// трейсинг: без OTEL_EXPORTER_OTLP_ENDPOINT — no-op (см. internal/tracing)
	shutdownTracing := tracing.Setup("analytics-service")

	httpSrv := httpapi.Start(cfg.HTTPAddr, analyzer, metrics.Handler())

	logging.Info("analytics-service запущен (RabbitMQ: %s, http: %s, storage: %s, локальное время: %s)",
		cfg.AMQPURL, cfg.HTTPAddr, cfg.Storage, time.Local)

	// Реконнект с бэкоффом: брокер может подниматься дольше нас.
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			break
		}
		if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
			logging.Warnf(ctx, "попытка %d: %v", attempt, err)
			select {
			case <-time.After(3 * time.Second):
			case <-ctx.Done():
			}
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	_ = shutdownTracing(shutdownCtx)
	logging.Info("analytics остановлен")
}

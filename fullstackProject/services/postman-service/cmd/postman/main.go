// postman-service («Почтальон») — микросервис на Go: вебхуки партнёров.
// Слушает RabbitMQ (booking.created/processed/expired/refunded из обменa
// cinema — их публикуют NestJS API и Go-воркер через транзакционный
// outbox), разворачивает события в доставки по подпискам партнёров и
// везёт их HTTP POST'ом с HMAC-SHA256-подписью: ретраи с экспоненциальным
// бэкоффом, дедупликация по паре «подписка + событие», DLQ для
// исчерпавших попытки. Витрина /subscriptions + /deliveries показывает
// подписки (секрет — маской) и доставки с итогами; кнопка перепосылки
// возвращает delivered/dead в очередь.
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, RabbitMQ/HTTP/память/
// Postgres — заменяемые адаптеры на периферии. gRPC не нужен: сервис
// никто не спрашивает синхронно — он слушает, доставляет и показывает.
package main

import (
	"context"
	"os/signal"
	"syscall"
	"time"

	"postman-service/internal/adapter/in/amqp"
	"postman-service/internal/adapter/in/httpapi"
	"postman-service/internal/adapter/out/memory"
	"postman-service/internal/adapter/out/postgres"
	"postman-service/internal/adapter/out/prom"
	"postman-service/internal/adapter/out/webhook"
	"postman-service/internal/config"
	"postman-service/internal/domain"
	"postman-service/internal/logging"
	"postman-service/internal/service"
	"postman-service/internal/tracing"
)

func main() {
	// JSON-логи ДО трейсинга: диагностика tracing.Setup тоже уходит JSON'ом
	logging.Setup()
	cfg := config.Load()

	// wiring: за портами SubscriptionsStore/DeliveriesStore стоит
	// конкретный адаптер; домен и service о них не знают. Хранилище
	// выбирает composition root по STORAGE: память (дефолт — стенд
	// без БД не падает) или Postgres со своей базой, которую адаптер
	// создаёт сам.
	var (
		subs       domain.SubscriptionsStore
		deliveries domain.DeliveriesStore
		closer     func() error
	)
	switch cfg.Storage {
	case "memory":
		store := memory.NewStore()
		subs = store.Subs
		deliveries = store.Deliveries
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю очереди доставок
		repo, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			logging.Fatalf("STORAGE=postgres: %v", err)
		}
		subs = repo.Subs
		deliveries = repo.Deliveries
		closer = repo.Close
	default:
		logging.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}
	if closer != nil {
		defer func() { _ = closer() }()
	}

	metrics := prom.New()
	sender := webhook.New(cfg.HTTPTimeout)
	postman := service.New(subs, deliveries, sender, metrics,
		cfg.DeliveryMax, cfg.DeliveryBaseBackoff, cfg.Batch)
	consumer := amqp.New(cfg.AMQPURL, postman, metrics, cfg.MaxAttempts, cfg.RetryTTLMs)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// трейсинг: без OTEL_EXPORTER_OTLP_ENDPOINT — no-op (см. internal/tracing)
	shutdownTracing := tracing.Setup("postman-service")

	httpSrv := httpapi.Start(cfg.HTTPAddr, postman, metrics)

	// конвейер доставки: тикер гоняет настоевшие вебхуки партнёрам.
	// Сервисы доставки и консьюмер живут независимо: сбой брокера
	// не останавливает перепосылку из витрины, и наоборот
	go func() {
		ticker := time.NewTicker(cfg.TickEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				postman.Tick(ctx)
			}
		}
	}()

	logging.Info("postman-service запущен (RabbitMQ: %s, http: %s, storage: %s, доставки: попыток %d, бэкофф %s)",
		cfg.AMQPURL, cfg.HTTPAddr, cfg.Storage, cfg.DeliveryMax, cfg.DeliveryBaseBackoff)

	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			break
		}
		if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
			logging.Warnf(ctx, "консьюмер, попытка %d: %v", attempt, err)
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
	logging.Info("postman остановлен")
}

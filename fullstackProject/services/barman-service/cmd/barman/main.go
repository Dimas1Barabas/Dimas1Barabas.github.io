// barman-service («Бармен») — микросервис на Go: экран бара кинотеатра.
// Слушает RabbitMQ (bar.order.created — заказ оформлен в NestJS API,
// bar.order.cancelled — владелец отменил), держит очередь приготовления
// в собственной базе и отдаёт витрину /bar: три колонки доски и кнопки
// «в работу / готов / выдан». Каждый переход публикует bar.order.status
// в обмен cinema — его читают NestJS API (обновление bar_orders) и
// notification-service («письмо» о готовности).
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, RabbitMQ/HTTP/память/
// Postgres — заменяемые адаптеры на периферии. gRPC не нужен: сервис
// никто не спрашивает синхронно — он слушает, показывает и сообщает.
package main

import (
	"context"
	"os/signal"
	"syscall"
	"time"

	"barman-service/internal/adapter/in/amqp"
	"barman-service/internal/adapter/in/httpapi"
	pubamqp "barman-service/internal/adapter/out/amqp"
	"barman-service/internal/adapter/out/memory"
	"barman-service/internal/adapter/out/postgres"
	"barman-service/internal/adapter/out/prom"
	"barman-service/internal/config"
	"barman-service/internal/domain"
	"barman-service/internal/logging"
	"barman-service/internal/service"
	"barman-service/internal/tracing"
)

func main() {
	// JSON-логи ДО трейсинга: диагностика tracing.Setup тоже уходит JSON'ом
	logging.Setup()
	cfg := config.Load()

	// wiring: за портом OrderStore стоит конкретный адаптер; домен
	// и service о них не знают. Хранилище выбирает composition root
	// по STORAGE: память (дефолт — стенд без БД не падает) или Postgres
	// со своей базой, которую адаптер создаёт сам.
	var store domain.OrderStore
	switch cfg.Storage {
	case "memory":
		store = memory.NewStore()
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю очереди бара
		pgStore, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			logging.Fatalf("STORAGE=postgres: %v", err)
		}
		defer func() { _ = pgStore.Close() }()
		store = pgStore
	default:
		logging.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}

	metrics := prom.New()
	pub := pubamqp.NewPublisher(cfg.AMQPURL, metrics)
	barman := service.NewBarman(store, pub)
	consumer := amqp.New(cfg.AMQPURL, barman, metrics, cfg.MaxAttempts, cfg.RetryTTLMs)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// трейсинг: без OTEL_EXPORTER_OTLP_ENDPOINT — no-op (см. internal/tracing)
	shutdownTracing := tracing.Setup("barman-service")

	httpSrv := httpapi.Start(cfg.HTTPAddr, barman, metrics)

	// издатель и консьюмер живут каждый своим реконнект-циклом: брокер
	// может подниматься дольше нас, сбой одного не тянет другой
	go func() {
		for attempt := 1; ; attempt++ {
			if ctx.Err() != nil {
				break
			}
			if err := pub.Run(ctx); err != nil && ctx.Err() == nil {
				logging.Warnf(ctx, "издатель, попытка %d: %v", attempt, err)
				select {
				case <-time.After(3 * time.Second):
				case <-ctx.Done():
				}
			}
		}
	}()

	logging.Info("barman-service запущен (RabbitMQ: %s, http: %s, storage: %s)",
		cfg.AMQPURL, cfg.HTTPAddr, cfg.Storage)

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
	logging.Info("barman остановлен")
}

// outbox-relay («Курьер») — микросервис на Go: доставляет события
// транзакционного outbox API в RabbitMQ. API пишет события в таблицу
// outbox_messages В бизнес-транзакции; Курьер батчами (FOR UPDATE SKIP
// LOCKED) публикует их в обмен cinema и будится gRPC-ем Notify сразу
// после коммита. Дропов нет: сбой публикации — бэкофф и повтор.
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, RabbitMQ/gRPC/HTTP/
// Postgres — заменяемые адаптеры на периферии.
package main

import (
	"context"
	"net"
	"os/signal"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"outbox-relay/internal/adapter/in/grpcapi"
	"outbox-relay/internal/adapter/in/httpapi"
	"outbox-relay/internal/adapter/out/amqp"
	"outbox-relay/internal/adapter/out/postgres"
	"outbox-relay/internal/adapter/out/prom"
	"outbox-relay/internal/config"
	"outbox-relay/internal/logging"
	pb "outbox-relay/internal/pb"
	"outbox-relay/internal/service"
	"outbox-relay/internal/tracing"
)

func main() {
	// JSON-логи ДО трейсинга: диагностика tracing.Setup тоже уходит JSON'ом
	logging.Setup()
	cfg := config.Load()

	// fail fast: без живого PG Курьер бессмыслен — молчаливый no-op
	// скрыл бы потерю доставки. Таблицу создаёт миграция API; если api
	// стартует параллельно и не дошёл — тики честно логируют и ждут.
	store, err := postgres.NewRepository(context.Background(),
		cfg.DatabaseURL, time.Duration(cfg.BackoffCapMs)*time.Millisecond)
	if err != nil {
		logging.Fatalf("хранилище outbox: %v", err)
	}
	defer func() { _ = store.Close() }()

	metrics := prom.New()
	pub := amqp.NewPublisher(cfg.AMQPURL, metrics)
	relay := service.NewRelay(store, pub, cfg.Batch)

	// gRPC — главный интерфейс: Notify зовёт API после COMMIT, Stats — витрина
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		logging.Fatalf("слушать %s: %v", cfg.GRPCAddr, err)
	}
	// otelgrpc: серверные спаны gRPC-вызовов, родитель — span клиента API
	grpcSrv := grpc.NewServer(grpc.StatsHandler(otelgrpc.NewServerHandler()))
	pb.RegisterOutboxRelayServer(grpcSrv, grpcapi.New(relay, metrics))
	// reflection — для grpcurl-проверок на живом стенде
	reflection.Register(grpcSrv)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// трейсинг: без OTEL_EXPORTER_OTLP_ENDPOINT — no-op (см. internal/tracing)
	shutdownTracing := tracing.Setup("outbox-relay")

	httpSrv := httpapi.Start(cfg.HTTPAddr, relay, metrics.Handler())

	go func() {
		logging.Info("gRPC OutboxRelay на %s", cfg.GRPCAddr)
		if err := grpcSrv.Serve(lis); err != nil {
			logging.Fatalf("gRPC Serve: %v", err)
		}
	}()

	// Тикер доставки: pending-хвост уходит батчами; Notify будит тик
	// раньше периода. До установления соединения Publish откажет — записи
	// останутся в pending с бэкоффом, следующий тик их доставит.
	ticker := time.NewTicker(time.Duration(cfg.PollMs) * time.Millisecond)
	defer ticker.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				relay.Tick(ctx)
			case <-relay.Wake():
				relay.Tick(ctx)
			}
		}
	}()

	logging.Info("outbox-relay запущен (RabbitMQ: %s, PG: %s, gRPC: %s, батч: %d, тик: %d мс)",
		cfg.AMQPURL, cfg.DatabaseURL, cfg.GRPCAddr, cfg.Batch, cfg.PollMs)

	// Реконнект издателя с бэкоффом: брокер может подниматься дольше нас.
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			break
		}
		if err := pub.Run(ctx); err != nil && ctx.Err() == nil {
			logging.Warnf(ctx, "попытка %d: %v", attempt, err)
			select {
			case <-time.After(3 * time.Second):
			case <-ctx.Done():
			}
		}
	}

	// graceful: даём инфлайт-gRPC-запросам доделать до 5 секунд
	done := make(chan struct{})
	go func() {
		grpcSrv.GracefulStop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		grpcSrv.Stop()
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	_ = shutdownTracing(shutdownCtx)
	logging.Info("outbox-relay остановлен")
}

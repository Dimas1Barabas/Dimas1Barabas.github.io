// detective-service («Детектив») — микросервис на Go: антифрод-скоринг
// броней. Чекаут NestJS API присылает факты брони и срез истории
// покупателя, домен считает скор по таблице рисков и отвечает
// вердиктом allow/review/block; review-брони копятся в витрине решений
// и ждут человека (approve/reject по gRPC от админки API).
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, gRPC/HTTP/память/
// Postgres — заменяемые адаптеры на периферии. Сервис чисто
// синхронный: брокер не нужен.
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

	"detective-service/internal/adapter/in/grpcapi"
	"detective-service/internal/adapter/in/httpapi"
	"detective-service/internal/adapter/out/memory"
	"detective-service/internal/adapter/out/postgres"
	"detective-service/internal/adapter/out/prom"
	"detective-service/internal/config"
	"detective-service/internal/domain"
	"detective-service/internal/logging"
	pb "detective-service/internal/pb"
	"detective-service/internal/service"
	"detective-service/internal/tracing"
)

func main() {
	// JSON-логи ДО трейсинга: диагностика tracing.Setup тоже уходит JSON'ом
	logging.Setup()
	cfg := config.Load()

	// wiring: за портом DecisionStore стоит конкретный адаптер; домен
	// и service о них не знают. Хранилище выбирает composition root
	// по STORAGE: память (дефолт — стенд без БД не падает) или Postgres
	// со своей базой, которую адаптер создаёт сам.
	var store domain.DecisionStore
	switch cfg.Storage {
	case "memory":
		store = memory.NewStore()
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю очереди ревью
		pgStore, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			logging.Fatalf("STORAGE=postgres: %v", err)
		}
		defer func() { _ = pgStore.Close() }()
		store = pgStore
	default:
		logging.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}

	if cfg.ReviewScore < 1 || cfg.BlockScore <= cfg.ReviewScore {
		logging.Fatalf("пороги должны быть 1 ≤ review < block: review=%d block=%d",
			cfg.ReviewScore, cfg.BlockScore)
	}
	detective := service.NewDetective(store, domain.Thresholds{
		Review: cfg.ReviewScore,
		Block:  cfg.BlockScore,
	})
	// счётчики вердиктов/резолвов/длительностей — на границе gRPC-адаптера
	metrics := prom.New()

	// gRPC — главный интерфейс: вердикты спрашивает чекаут API,
	// резолвы приносит админ-витрина
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		logging.Fatalf("слушать %s: %v", cfg.GRPCAddr, err)
	}
	// otelgrpc: серверные спаны gRPC-вызовов, родитель — span клиента API
	grpcSrv := grpc.NewServer(grpc.StatsHandler(otelgrpc.NewServerHandler()))
	pb.RegisterDetectiveServer(grpcSrv, grpcapi.New(detective, metrics))
	// reflection — для grpcurl-проверок на живом стенде
	reflection.Register(grpcSrv)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// трейсинг: без OTEL_EXPORTER_OTLP_ENDPOINT — no-op (см. internal/tracing)
	shutdownTracing := tracing.Setup("detective-service")

	httpSrv := httpapi.Start(cfg.HTTPAddr, detective, metrics.Handler())

	go func() {
		logging.Info("gRPC Detective на %s", cfg.GRPCAddr)
		if err := grpcSrv.Serve(lis); err != nil {
			logging.Fatalf("gRPC Serve: %v", err)
		}
	}()

	logging.Info("detective-service запущен (gRPC: %s, storage: %s, пороги: review %d / block %d)",
		cfg.GRPCAddr, cfg.Storage, cfg.ReviewScore, cfg.BlockScore)

	// синхронному сервису нечего ждать — только сигнала остановки
	<-ctx.Done()

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
	logging.Info("detective остановлен")
}

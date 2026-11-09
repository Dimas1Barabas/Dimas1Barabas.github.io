// flags-service («Суфлёр») — микросервис на Go: тумблеры фич с процентной
// раскаткой и kill-switch. Хранит состояние флагов, считает детерминированные
// вердикты (hash(key|entity) % 100 < percentage) и ведёт аудит правок;
// по gRPC отвечает Evaluate и обслуживает админку (Upsert/Delete/List).
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

	"flags-service/internal/adapter/in/grpcapi"
	"flags-service/internal/adapter/in/httpapi"
	"flags-service/internal/adapter/out/memory"
	"flags-service/internal/adapter/out/postgres"
	"flags-service/internal/adapter/out/prom"
	"flags-service/internal/config"
	"flags-service/internal/domain"
	"flags-service/internal/logging"
	pb "flags-service/internal/pb"
	"flags-service/internal/service"
	"flags-service/internal/tracing"
)

func main() {
	// JSON-логи ДО трейсинга: диагностика tracing.Setup тоже уходит JSON'ом
	logging.Setup()
	cfg := config.Load()

	// wiring: за портом FlagStore стоит конкретный адаптер; домен
	// и service о них не знают. Хранилище выбирает composition root
	// по STORAGE: память (дефолт — стенд без БД не падает) или Postgres
	// со своей базой, которую адаптер создаёт сам. Оба адаптера закрывают
	// оба порта: флаги и счётчики метрик экспериментов живут в одном
	// хранилище — right behind the same STORAGE switch.
	var store domain.FlagStore
	var stats domain.ExperimentStore
	switch cfg.Storage {
	case "memory":
		mem := memory.NewStore()
		store = mem
		stats = mem
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю флагов — а это уже
		// не «новая фича скрыта», а молча сброшенная раскатка
		pgStore, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			logging.Fatalf("STORAGE=postgres: %v", err)
		}
		defer func() { _ = pgStore.Close() }()
		store = pgStore
		stats = pgStore
	default:
		logging.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}

	flags := service.New(store, stats)
	// счётчики вердиктов/правок — на границе gRPC-адаптера
	metrics := prom.New()

	// gRPC — главный интерфейс: вердикты спрашивают гварды NestJS API,
	// правки присылает админка API
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		logging.Fatalf("слушать %s: %v", cfg.GRPCAddr, err)
	}
	// otelgrpc: серверные спаны gRPC-вызовов, родитель — span клиента API
	grpcSrv := grpc.NewServer(grpc.StatsHandler(otelgrpc.NewServerHandler()))
	pb.RegisterFlagsServer(grpcSrv, grpcapi.New(flags, metrics))
	// reflection — для grpcurl-проверок на живом стенде
	reflection.Register(grpcSrv)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// трейсинг: без OTEL_EXPORTER_OTLP_ENDPOINT — no-op (см. internal/tracing)
	shutdownTracing := tracing.Setup("flags-service")

	httpSrv := httpapi.Start(cfg.HTTPAddr, flags, metrics.Handler())

	go func() {
		logging.Info("gRPC Flags на %s", cfg.GRPCAddr)
		if err := grpcSrv.Serve(lis); err != nil {
			logging.Fatalf("gRPC Serve: %v", err)
		}
	}()

	logging.Info("flags-service запущен (gRPC: %s, storage: %s)", cfg.GRPCAddr, cfg.Storage)

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
	logging.Info("flags-service остановлен")
}

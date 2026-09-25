// pricing-service («Тарификатор») — микросервис на Go: копит спрос
// на сеансы из событий RabbitMQ (бронь создала резерв, места вернулись
// в продажу) и отвечает ценой места по gRPC — база афиши, умноженная
// на факторы времени суток, выходного и заполненности зала.
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, RabbitMQ/gRPC/HTTP/
// память — заменяемые адаптеры на периферии.
package main

import (
	"context"
	"log"
	"net"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"pricing-service/internal/adapter/in/amqp"
	"pricing-service/internal/adapter/in/grpcapi"
	"pricing-service/internal/adapter/in/httpapi"
	"pricing-service/internal/adapter/out/memory"
	"pricing-service/internal/adapter/out/postgres"
	"pricing-service/internal/config"
	"pricing-service/internal/domain"
	pb "pricing-service/internal/pb"
	"pricing-service/internal/service"
)

func main() {
	log.SetFlags(log.Ltime)
	cfg := config.Load()

	// wiring: за портом DemandStore стоит конкретный адаптер; домен
	// и service о них не знают. Хранилище выбирает composition root
	// по STORAGE: память (дефолт — стенд без БД не падает) или Postgres
	// со своей базой, которую адаптер создаёт сам.
	var store domain.DemandStore
	switch cfg.Storage {
	case "memory":
		store = memory.NewStore()
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю спроса
		pgStore, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("STORAGE=postgres: %v", err)
		}
		defer pgStore.Close()
		store = pgStore
	default:
		log.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}

	pricer := service.NewPricer(store)
	consumer := amqp.New(cfg.AMQPURL, pricer, cfg.MaxAttempts, cfg.RetryTTLMs)

	// gRPC — главный интерфейс: квот цены спрашивает NestJS API
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("слушать %s: %v", cfg.GRPCAddr, err)
	}
	grpcSrv := grpc.NewServer()
	pb.RegisterPricingServer(grpcSrv, grpcapi.New(pricer))
	// reflection — для grpcurl-проверок на живом стенде
	reflection.Register(grpcSrv)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	httpSrv := httpapi.Start(cfg.HTTPAddr, pricer)

	go func() {
		log.Printf("gRPC Pricing на %s", cfg.GRPCAddr)
		if err := grpcSrv.Serve(lis); err != nil {
			log.Fatalf("gRPC Serve: %v", err)
		}
	}()

	log.Printf("pricing-service запущен (RabbitMQ: %s, gRPC: %s, storage: %s, локальное время: %s)",
		cfg.AMQPURL, cfg.GRPCAddr, cfg.Storage, time.Local)

	// Реконнект с бэкоффом: брокер может подниматься дольше нас.
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			break
		}
		if err := consumer.Run(ctx); err != nil && ctx.Err() == nil {
			log.Printf("попытка %d: %v", attempt, err)
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
	log.Printf("pricing остановлен")
}

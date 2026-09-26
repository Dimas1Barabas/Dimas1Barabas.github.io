// ratelimiter-service («Привратник») — микросервис на Go: держит
// token-корзины лимитов частоты (создание брони на пользователя,
// вход на email) и по gRPC решает, допустить ли действие. Отказ —
// штатный вердикт с ожиданием, а не ошибка RPC; падение самого
// сервиса вызывающая сторона гасит fail-open'ом.
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, gRPC/HTTP/память/
// Postgres — заменяемые адаптеры на периферии. Сервис чисто
// синхронный: брокер не нужен.
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

	"ratelimiter-service/internal/adapter/in/grpcapi"
	"ratelimiter-service/internal/adapter/in/httpapi"
	"ratelimiter-service/internal/adapter/out/memory"
	"ratelimiter-service/internal/adapter/out/postgres"
	"ratelimiter-service/internal/config"
	"ratelimiter-service/internal/domain"
	pb "ratelimiter-service/internal/pb"
	"ratelimiter-service/internal/service"
)

func main() {
	log.SetFlags(log.Ltime)
	cfg := config.Load()

	// wiring: за портом BucketStore стоит конкретный адаптер; домен
	// и service о них не знают. Хранилище выбирает composition root
	// по STORAGE: память (дефолт — стенд без БД не падает) или Postgres
	// со своей базой, которую адаптер создаёт сам.
	var store domain.BucketStore
	switch cfg.Storage {
	case "memory":
		store = memory.NewStore()
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю корзин. Рестарт обнуляет
		// корзины памяти — для лимитов это осознанно
		pgStore, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("STORAGE=postgres: %v", err)
		}
		defer pgStore.Close()
		store = pgStore
	default:
		log.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}

	if cfg.RateBookingsPerMin < 1 || cfg.RateLoginPerMin < 1 {
		log.Fatalf("лимиты должны быть ≥ 1 в минуту: bookings=%d login=%d",
			cfg.RateBookingsPerMin, cfg.RateLoginPerMin)
	}
	policies := map[domain.Action]domain.Policy{
		domain.ActionBookingsCreate: domain.PolicyOf(cfg.RateBookingsPerMin),
		domain.ActionAuthLogin:      domain.PolicyOf(cfg.RateLoginPerMin),
	}
	limiter := service.NewLimiter(store, policies)

	// gRPC — главный интерфейс: токены спрашивают гварды NestJS API
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("слушать %s: %v", cfg.GRPCAddr, err)
	}
	grpcSrv := grpc.NewServer()
	pb.RegisterRateLimiterServer(grpcSrv, grpcapi.New(limiter))
	// reflection — для grpcurl-проверок на живом стенде
	reflection.Register(grpcSrv)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	httpSrv := httpapi.Start(cfg.HTTPAddr, limiter)

	go func() {
		log.Printf("gRPC RateLimiter на %s", cfg.GRPCAddr)
		if err := grpcSrv.Serve(lis); err != nil {
			log.Fatalf("gRPC Serve: %v", err)
		}
	}()

	log.Printf("ratelimiter-service запущен (gRPC: %s, storage: %s, политики: бронь %d/мин, вход %d/мин)",
		cfg.GRPCAddr, cfg.Storage, cfg.RateBookingsPerMin, cfg.RateLoginPerMin)

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
	log.Printf("ratelimiter остановлен")
}

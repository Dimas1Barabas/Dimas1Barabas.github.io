// reminder-service — микросервис на Go: планирует напоминания
// о сеансах по gRPC (подтверждение брони) и, когда подходит срок,
// рассылает их событием user.session.reminder в RabbitMQ — письмо
// собирает notification-service, живой баннер — SSE API.
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

	"reminder-service/internal/adapter/in/grpcapi"
	"reminder-service/internal/adapter/in/httpapi"
	"reminder-service/internal/adapter/out/amqp"
	"reminder-service/internal/adapter/out/memory"
	"reminder-service/internal/adapter/out/postgres"
	"reminder-service/internal/config"
	"reminder-service/internal/domain"
	pb "reminder-service/internal/pb"
	"reminder-service/internal/service"
)

func main() {
	log.SetFlags(log.Ltime)
	cfg := config.Load()

	// wiring: за портом ReminderStore стоит конкретный адаптер; домен
	// и service о них не знают. Хранилище выбирает composition root
	// по STORAGE: память (дефолт — стенд без БД не падает) или Postgres
	// со своей базой, которую адаптер создаёт сам.
	var store domain.ReminderStore
	switch cfg.Storage {
	case "memory":
		store = memory.NewStore()
	case "postgres":
		// fail fast: без живого PG сервис не стартует, молчаливый
		// fallback на память скрыл бы потерю напоминаний
		pgStore, err := postgres.NewRepository(context.Background(), cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("STORAGE=postgres: %v", err)
		}
		defer pgStore.Close()
		store = pgStore
	default:
		log.Fatalf("неизвестный STORAGE=%q: ожидается memory или postgres", cfg.Storage)
	}

	pub := amqp.NewPublisher(cfg.AMQPURL)
	scheduler := service.NewScheduler(store, pub, time.Duration(cfg.LeadMinutes)*time.Minute)

	// gRPC — главный интерфейс: Schedule/Cancel зовёт NestJS API
	lis, err := net.Listen("tcp", cfg.GRPCAddr)
	if err != nil {
		log.Fatalf("слушать %s: %v", cfg.GRPCAddr, err)
	}
	grpcSrv := grpc.NewServer()
	pb.RegisterRemindersServer(grpcSrv, grpcapi.New(scheduler))
	// reflection — для grpcurl-проверок на живом стенде
	reflection.Register(grpcSrv)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	httpSrv := httpapi.Start(cfg.HTTPAddr, scheduler)

	go func() {
		log.Printf("gRPC Reminders на %s", cfg.GRPCAddr)
		if err := grpcSrv.Serve(lis); err != nil {
			log.Fatalf("gRPC Serve: %v", err)
		}
	}()

	// Тикер отправки: наступившие напоминания уходят в брокер.
	// До установления соединения Publish откажет — записи ждут
	// в SCHEDULED, следующий тик их доставит.
	ticker := time.NewTicker(time.Duration(cfg.TickSeconds) * time.Second)
	defer ticker.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				scheduler.Tick(ctx)
			}
		}
	}()

	log.Printf("reminder-service запущен (RabbitMQ: %s, gRPC: %s, storage: %s, окно: %d мин, тик: %d c)",
		cfg.AMQPURL, cfg.GRPCAddr, cfg.Storage, cfg.LeadMinutes, cfg.TickSeconds)

	// Реконнект издателя с бэкоффом: брокер может подниматься дольше нас.
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			break
		}
		if err := pub.Run(ctx); err != nil && ctx.Err() == nil {
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
	log.Printf("reminder остановлен")
}

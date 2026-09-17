// notification-service — микросервис на Go: превращает вердикты брони
// (booking.processed / booking.refunded / booking.expired) в клиентские
// уведомления, «отправляет» их (в стенде — в лог) и хранит историю.
//
// main — единственное место, где слои знакомятся друг с другом: чистый
// composition root без бизнес-логики. Архитектура — гексагональная
// (ports & adapters): домен и use-cases в центре, RabbitMQ/HTTP/память —
// заменяемые адаптеры на периферии.
package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"
	"time"

	"notification-service/internal/adapter/in/amqp"
	"notification-service/internal/adapter/in/httpapi"
	"notification-service/internal/adapter/out/console"
	"notification-service/internal/adapter/out/memory"
	"notification-service/internal/config"
	"notification-service/internal/service"
)

func main() {
	log.SetFlags(log.Ltime)
	cfg := config.Load()

	// wiring: за каждым портом домена стоит конкретный адаптер;
	// домен и service о них не знают
	repo := memory.NewRepository(cfg.BufferSize)
	metrics := memory.NewMetrics()
	notifier := service.NewNotifier(console.NewSender(), repo, metrics)
	consumer := amqp.New(cfg.AMQPURL, notifier, cfg.MaxAttempts, cfg.RetryTTLMs)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	httpSrv := httpapi.Start(cfg.HTTPAddr, notifier)

	log.Printf("notification-service запущен (RabbitMQ: %s)", cfg.AMQPURL)

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

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	log.Printf("notification остановлен: всего %v отправлено, %v неудачно доставлено",
		metrics.Snapshot()["sent"], metrics.Snapshot()["failed"])
}

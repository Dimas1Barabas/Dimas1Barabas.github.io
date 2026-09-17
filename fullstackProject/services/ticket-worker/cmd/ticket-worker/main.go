// ticket-worker — микросервис на Go, обрабатывающий брони из RabbitMQ.
//
// Подписывается на booking.created (обмен «cinema»), имитирует оплату
// и публикует результат booking.processed, который NestJS-API применяет к брони.
// Кроме того, консьюмит booking.cancelled — запросы возврата из компенсирующей
// саги отмены — и отвечает вердиктом booking.refunded. Третий поток —
// booking.payment.timeout: истёкшие резервы, их присылает dead-letter'ом
// wait-очередь API, вердикт — booking.expired.
//
// main — точка сборки: читает конфиг, строит зависимости и крутит цикл
// реконнекта к брокеру; вся логика — в internal/.
package main

import (
	"context"
	"log"
	"os/signal"
	"syscall"
	"time"

	"ticket-worker/internal/config"
	"ticket-worker/internal/httpserver"
	"ticket-worker/internal/processing"
	"ticket-worker/internal/rabbitmq"
	"ticket-worker/internal/stats"
)

func main() {
	log.SetFlags(log.Ltime)
	cfg := config.Load()
	st := stats.New(cfg.WorkerID)

	proc := &processing.Processor{
		WorkerID:          cfg.WorkerID,
		PayMin:            cfg.MinLatency,
		PayMax:            cfg.MaxLatency,
		PaySuccessRate:    cfg.SuccessRate,
		RefundMin:         cfg.RefundMinLatency,
		RefundMax:         cfg.RefundMaxLatency,
		RefundSuccessRate: cfg.RefundSuccessRate,
	}
	consumer := rabbitmq.New(cfg, proc, st)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	httpSrv := httpserver.Start(cfg.HTTPAddr, st)

	log.Printf("ticket-worker %s запущен (RabbitMQ: %s)", cfg.WorkerID, cfg.AMQPURL)

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
	log.Printf("воркер остановлен: обработано %d, подтверждено %d, отказов %d, истекло %d, возвратов %d (неудачных %d)",
		st.Received.Load(), st.Confirmed.Load(), st.Failed.Load(),
		st.Expired.Load(), st.Refunds.Load(), st.RefundFailed.Load())
}

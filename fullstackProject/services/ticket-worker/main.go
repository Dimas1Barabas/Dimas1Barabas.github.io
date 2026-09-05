// ticket-worker — микросервис на Go, обрабатывающий брони из RabbitMQ.
//
// Подписывается на booking.created (обмен «cinema»), имитирует оплату
// и публикует результат booking.processed, который NestJS-API применяет к брони.
// Кроме того, консьюмит booking.cancelled — запросы возврата из компенсирующей
// саги отмены — и отвечает вердиктом booking.refunded.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// ---------- конфигурация ----------

type Config struct {
	AMQPURL           string        // где живёт RabbitMQ
	Exchange          string        // topic-обмен «cinema»
	InQueue           string        // очередь оплат
	CancelQueue       string        // очередь возвратов (сага отмены)
	OutRK             string        // routing key вердикта оплаты
	RefundRK          string        // routing key вердикта возврата
	HTTPAddr          string        // адрес health/stats-эндпоинтов
	WorkerID          string        // имя воркера (видно в брони)
	MinLatency        time.Duration // имитация «оплаты»
	MaxLatency        time.Duration
	SuccessRate       float64       // доля успешных оплат
	RefundMinLatency  time.Duration // имитация «возврата»
	RefundMaxLatency  time.Duration
	RefundSuccessRate float64 // доля успешных возвратов
}

func loadConfig() Config {
	return Config{
		AMQPURL:     env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		Exchange:    "cinema",
		InQueue:     "worker.booking.created",
		CancelQueue: "worker.booking.cancelled",
		OutRK:       "booking.processed",
		RefundRK:    "booking.refunded",
		HTTPAddr:    env("HTTP_ADDR", ":8081"),
		WorkerID:    env("WORKER_ID", "go-worker-1"),
		MinLatency: time.Duration(envInt("PROCESS_MIN_MS", 1200)) *
			time.Millisecond,
		MaxLatency: time.Duration(envInt("PROCESS_MAX_MS", 2800)) *
			time.Millisecond,
		SuccessRate: envFloat("SUCCESS_RATE", 0.9),
		RefundMinLatency: time.Duration(envInt("REFUND_MIN_MS", 800)) *
			time.Millisecond,
		RefundMaxLatency: time.Duration(envInt("REFUND_MAX_MS", 1600)) *
			time.Millisecond,
		RefundSuccessRate: envFloat("REFUND_SUCCESS_RATE", 0.9),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

// ---------- контракты событий (общие с NestJS API) ----------

// BookingCreated — событие от API: booking.created.
type BookingCreated struct {
	BookingID    string    `json:"bookingId"`
	MovieID      string    `json:"movieId"`
	MovieTitle   string    `json:"movieTitle"`
	CustomerName string    `json:"customerName"`
	Seats        []string  `json:"seats"` // коды «ряд-место», например "5-7"
	TotalRub     int       `json:"totalRub"`
	CreatedAt    time.Time `json:"createdAt"`
}

// BookingProcessed — ответ воркера: booking.processed.
type BookingProcessed struct {
	BookingID   string `json:"bookingId"`
	Status      string `json:"status"` // CONFIRMED | FAILED
	Message     string `json:"message"`
	ProcessedBy string `json:"processedBy"`
	ProcessedAt string `json:"processedAt"`
}

// BookingCancelled — событие от API: booking.cancelled (запрос возврата).
type BookingCancelled struct {
	BookingID    string    `json:"bookingId"`
	MovieID      string    `json:"movieId"`
	MovieTitle   string    `json:"movieTitle"`
	CustomerName string    `json:"customerName"`
	Seats        []string  `json:"seats"`
	TotalRub     int       `json:"totalRub"`
	CancelledAt  time.Time `json:"cancelledAt"`
}

// BookingRefunded — ответ воркера: booking.refunded.
type BookingRefunded struct {
	BookingID   string `json:"bookingId"`
	Status      string `json:"status"` // CANCELLED | REFUND_FAILED
	Message     string `json:"message"`
	ProcessedBy string `json:"processedBy"`
	ProcessedAt string `json:"processedAt"`
}

// ---------- статистика ----------

type Stats struct {
	Received     atomic.Int64
	Confirmed    atomic.Int64
	Failed       atomic.Int64
	Refunds      atomic.Int64
	RefundFailed atomic.Int64
	Errors       atomic.Int64
	StartedAt    time.Time
	WorkerID     string
}

func (s *Stats) snapshot() map[string]any {
	return map[string]any{
		"workerId":     s.WorkerID,
		"uptimeSec":    int(time.Since(s.StartedAt).Seconds()),
		"received":     s.Received.Load(),
		"confirmed":    s.Confirmed.Load(),
		"failed":       s.Failed.Load(),
		"refunds":      s.Refunds.Load(),
		"refundFailed": s.RefundFailed.Load(),
		"errors":       s.Errors.Load(),
	}
}

// ---------- HTTP: /health и /stats ----------

func serveHTTP(addr string, stats *Stats) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/stats", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, stats.snapshot())
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "ticket-worker",
			"endpoints": []string{"/health", "/stats"},
		})
	})

	srv := &http.Server{Addr: addr, Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	log.Printf("http: /health и /stats на %s", addr)
	return srv
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// ---------- обработка брони ----------

// process имитирует работу платёжного шлюза: задержка + вердикт.
func process(cfg Config, ev BookingCreated) BookingProcessed {
	latency := cfg.MinLatency + time.Duration(
		rand.Int64N(int64(cfg.MaxLatency-cfg.MinLatency)),
	)
	time.Sleep(latency)

	now := time.Now().UTC().Format(time.RFC3339)
	if rand.Float64() < cfg.SuccessRate {
		return BookingProcessed{
			BookingID:   ev.BookingID,
			Status:      "CONFIRMED",
			Message:     fmt.Sprintf("Оплата %d ₽ прошла. Места %s. Приятного просмотра!", ev.TotalRub, strings.Join(ev.Seats, ", ")),
			ProcessedBy: cfg.WorkerID,
			ProcessedAt: now,
		}
	}
	return BookingProcessed{
		BookingID:   ev.BookingID,
		Status:      "FAILED",
		Message:     fmt.Sprintf("Платёж отклонён банком (код %02d). Бронь отменена, деньги не списаны.", rand.IntN(90)+10),
		ProcessedBy: cfg.WorkerID,
		ProcessedAt: now,
	}
}

// refund имитирует возврат платежа для саги отмены: задержка + вердикт.
func refund(cfg Config, ev BookingCancelled) BookingRefunded {
	latency := cfg.RefundMinLatency + time.Duration(
		rand.Int64N(int64(cfg.RefundMaxLatency-cfg.RefundMinLatency)),
	)
	time.Sleep(latency)

	now := time.Now().UTC().Format(time.RFC3339)
	if rand.Float64() < cfg.RefundSuccessRate {
		return BookingRefunded{
			BookingID:   ev.BookingID,
			Status:      "CANCELLED",
			Message:     fmt.Sprintf("Возврат %d ₽ зачислен. Места %s снова в продаже.", ev.TotalRub, strings.Join(ev.Seats, ", ")),
			ProcessedBy: cfg.WorkerID,
			ProcessedAt: now,
		}
	}
	return BookingRefunded{
		BookingID:   ev.BookingID,
		Status:      "REFUND_FAILED",
		Message:     fmt.Sprintf("Банк отклонил возврат (код %02d). Бронь остаётся подтверждённой, места держатся.", rand.IntN(90)+10),
		ProcessedBy: cfg.WorkerID,
		ProcessedAt: now,
	}
}

// ---------- консьюмер RabbitMQ ----------

func runConsumer(ctx context.Context, cfg Config, stats *Stats) error {
	conn, err := amqp.Dial(cfg.AMQPURL)
	if err != nil {
		return fmt.Errorf("подключение к RabbitMQ: %w", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("канал: %w", err)
	}
	defer ch.Close()

	// Тот же topic-обмен, что объявляет NestJS API — параметры идентичны.
	if err := ch.ExchangeDeclare(cfg.Exchange, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("обмен %s: %w", cfg.Exchange, err)
	}
	if _, err := ch.QueueDeclare(cfg.InQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s: %w", cfg.InQueue, err)
	}
	if err := ch.QueueBind(cfg.InQueue, "booking.created", cfg.Exchange, false, nil); err != nil {
		return fmt.Errorf("бинд %s: %w", cfg.InQueue, err)
	}
	// Вторая очередь — запросы возврата из саги отмены брони.
	if _, err := ch.QueueDeclare(cfg.CancelQueue, true, false, false, false, nil); err != nil {
		return fmt.Errorf("очередь %s: %w", cfg.CancelQueue, err)
	}
	if err := ch.QueueBind(cfg.CancelQueue, "booking.cancelled", cfg.Exchange, false, nil); err != nil {
		return fmt.Errorf("бинд %s: %w", cfg.CancelQueue, err)
	}
	// Берём по одному сообщению за раз — «честная» обработка без перегрузки.
	if err := ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.Consume(cfg.InQueue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}
	refunds, err := ch.Consume(cfg.CancelQueue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %s: %w", cfg.CancelQueue, err)
	}

	log.Printf("воркер %s слушает %s / booking.created + booking.cancelled",
		cfg.WorkerID, cfg.InQueue)

	for {
		select {
		case <-ctx.Done():
			return nil
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("канал закрыт, переподключаюсь")
			}
			handleDelivery(cfg, stats, ch, d)
		case d, ok := <-refunds:
			if !ok {
				return errors.New("канал закрыт, переподключаюсь")
			}
			handleDelivery(cfg, stats, ch, d)
		}
	}
}

// publishJSON отправляет событие в обмен «cinema» персистентно.
func publishJSON(ch *amqp.Channel, exchange, rk string, body []byte) error {
	return ch.Publish(exchange, rk, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
		Body:         body,
	})
}

// handleDelivery разводит потоки по routing key: оплата или возврат.
func handleDelivery(cfg Config, stats *Stats, ch *amqp.Channel, d amqp.Delivery) {
	switch d.RoutingKey {
	case "booking.created":
		handleCreated(cfg, stats, ch, d)
	case "booking.cancelled":
		handleCancelled(cfg, stats, ch, d)
	default:
		log.Printf("неизвестный routing key %q — отбрасываю", d.RoutingKey)
		stats.Errors.Add(1)
		_ = d.Nack(false, false)
	}
}

func handleCreated(cfg Config, stats *Stats, ch *amqp.Channel, d amqp.Delivery) {
	stats.Received.Add(1)

	var ev BookingCreated
	if err := json.Unmarshal(d.Body, &ev); err != nil {
		log.Printf("битое сообщение: %v", err)
		stats.Errors.Add(1)
		_ = d.Nack(false, false) // не возвращаем в очередь
		return
	}

	log.Printf("← %s: «%s», места %s, %d ₽",
		ev.BookingID, ev.MovieTitle, strings.Join(ev.Seats, ", "), ev.TotalRub)

	result := process(cfg, ev)
	body, err := json.Marshal(result)
	if err != nil {
		stats.Errors.Add(1)
		_ = d.Nack(false, true)
		return
	}

	if err := publishJSON(ch, cfg.Exchange, cfg.OutRK, body); err != nil {
		log.Printf("→ ! %s: %v", ev.BookingID, err)
		stats.Errors.Add(1)
		_ = d.Nack(false, true)
		return
	}

	_ = d.Ack(false)
	if result.Status == "CONFIRMED" {
		stats.Confirmed.Add(1)
	} else {
		stats.Failed.Add(1)
	}
	log.Printf("→ %s: %s — %s", ev.BookingID, result.Status, result.Message)
}

func handleCancelled(cfg Config, stats *Stats, ch *amqp.Channel, d amqp.Delivery) {
	stats.Received.Add(1)

	var ev BookingCancelled
	if err := json.Unmarshal(d.Body, &ev); err != nil {
		log.Printf("битое сообщение: %v", err)
		stats.Errors.Add(1)
		_ = d.Nack(false, false)
		return
	}

	log.Printf("← возврат %s: «%s», места %s, %d ₽",
		ev.BookingID, ev.MovieTitle, strings.Join(ev.Seats, ", "), ev.TotalRub)

	result := refund(cfg, ev)
	body, err := json.Marshal(result)
	if err != nil {
		stats.Errors.Add(1)
		_ = d.Nack(false, true)
		return
	}

	if err := publishJSON(ch, cfg.Exchange, cfg.RefundRK, body); err != nil {
		log.Printf("→ ! %s: %v", ev.BookingID, err)
		stats.Errors.Add(1)
		_ = d.Nack(false, true)
		return
	}

	_ = d.Ack(false)
	if result.Status == "CANCELLED" {
		stats.Refunds.Add(1)
	} else {
		stats.RefundFailed.Add(1)
	}
	log.Printf("→ %s: %s — %s", ev.BookingID, result.Status, result.Message)
}

func main() {
	log.SetFlags(log.Ltime)
	cfg := loadConfig()
	stats := &Stats{StartedAt: time.Now(), WorkerID: cfg.WorkerID}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	httpSrv := serveHTTP(cfg.HTTPAddr, stats)

	log.Printf("ticket-worker %s запущен (RabbitMQ: %s)", cfg.WorkerID, cfg.AMQPURL)

	// Реконнект с бэкоффом: брокер может подниматься дольше нас.
	for attempt := 1; ; attempt++ {
		if ctx.Err() != nil {
			break
		}
		if err := runConsumer(ctx, cfg, stats); err != nil && ctx.Err() == nil {
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
	log.Printf("воркер остановлен: обработано %d, подтверждено %d, отказов %d, возвратов %d (неудачных %d)",
		stats.Received.Load(), stats.Confirmed.Load(), stats.Failed.Load(),
		stats.Refunds.Load(), stats.RefundFailed.Load())
}

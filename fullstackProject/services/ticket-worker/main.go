// ticket-worker — микросервис на Go, обрабатывающий брони из RabbitMQ.
//
// Подписывается на booking.created (обмен «cinema»), имитирует оплату
// и публикует результат booking.processed, который NestJS-API применяет к брони.
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
	AMQPURL     string        // где живёт RabbitMQ
	Exchange    string        // topic-обмен «cinema»
	InQueue     string        // очередь, из которой читаем
	OutRK       string        // routing key результата
	HTTPAddr    string        // адрес health/stats-эндпоинтов
	WorkerID    string        // имя воркера (видно в брони)
	MinLatency  time.Duration // имитация «оплаты»
	MaxLatency  time.Duration
	SuccessRate float64 // доля успешных оплат
}

func loadConfig() Config {
	return Config{
		AMQPURL:  env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		Exchange: "cinema",
		InQueue:  "worker.booking.created",
		OutRK:    "booking.processed",
		HTTPAddr: env("HTTP_ADDR", ":8081"),
		WorkerID: env("WORKER_ID", "go-worker-1"),
		MinLatency: time.Duration(envInt("PROCESS_MIN_MS", 1200)) *
			time.Millisecond,
		MaxLatency: time.Duration(envInt("PROCESS_MAX_MS", 2800)) *
			time.Millisecond,
		SuccessRate: envFloat("SUCCESS_RATE", 0.9),
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

// ---------- статистика ----------

type Stats struct {
	Received   atomic.Int64
	Confirmed  atomic.Int64
	Failed     atomic.Int64
	Errors     atomic.Int64
	StartedAt  time.Time
	WorkerID   string
}

func (s *Stats) snapshot() map[string]any {
	return map[string]any{
		"workerId":  s.WorkerID,
		"uptimeSec": int(time.Since(s.StartedAt).Seconds()),
		"received":  s.Received.Load(),
		"confirmed": s.Confirmed.Load(),
		"failed":    s.Failed.Load(),
		"errors":    s.Errors.Load(),
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
			"service": "ticket-worker",
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
	// Берём по одному сообщению за раз — «честная» обработка без перегрузки.
	if err := ch.Qos(1, 0, false); err != nil {
		return fmt.Errorf("qos: %w", err)
	}

	deliveries, err := ch.Consume(cfg.InQueue, "", false, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}

	log.Printf("воркер %s слушает %s / booking.created", cfg.WorkerID, cfg.InQueue)

	for {
		select {
		case <-ctx.Done():
			return nil
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("канал закрыт, переподключаюсь")
			}
			handleDelivery(cfg, stats, ch, d)
		}
	}
}

func handleDelivery(cfg Config, stats *Stats, ch *amqp.Channel, d amqp.Delivery) {
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

	err = ch.Publish(cfg.Exchange, cfg.OutRK, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
		Body:         body,
	})
	if err != nil {
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
	log.Printf("воркер остановлен: обработано %d, подтверждено %d, отказов %d",
		stats.Received.Load(), stats.Confirmed.Load(), stats.Failed.Load())
}

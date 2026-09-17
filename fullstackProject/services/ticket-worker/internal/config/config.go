// Package config читает настройки воркера из переменных окружения.
// Всё со значениями по умолчанию — стенд поднимается без .env.
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	AMQPURL           string        // где живёт RabbitMQ
	Exchange          string        // topic-обмен «cinema»
	InQueue           string        // очередь оплат
	CancelQueue       string        // очередь возвратов (сага отмены)
	ExpireQueue       string        // очередь истёкших резервов (TTL wait-очереди)
	HTTPAddr          string        // адрес health/stats-эндпоинтов
	WorkerID          string        // имя воркера (видно в брони)
	MinLatency        time.Duration // имитация «оплаты»
	MaxLatency        time.Duration
	SuccessRate       float64       // доля успешных оплат
	RefundMinLatency  time.Duration // имитация «возврата»
	RefundMaxLatency  time.Duration
	RefundSuccessRate float64 // доля успешных возвратов
	MaxAttempts       int     // попыток обработки, дальше — parking
	RetryTTLMs        int     // сколько retry-очередь держит сообщение
}

// Load собирает конфиг из окружения. Routing keys вердиктов — константы
// пакета events: контракт общий с NestJS API, в конфиге не дублируется.
func Load() Config {
	return Config{
		AMQPURL:     env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		Exchange:    "cinema",
		InQueue:     "worker.booking.created",
		CancelQueue: "worker.booking.cancelled",
		ExpireQueue: "worker.booking.payment_timeout",
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
		MaxAttempts:       envInt("RETRY_MAX_ATTEMPTS", 3),
		RetryTTLMs:        envInt("RETRY_TTL_MS", 5000),
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

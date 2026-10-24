// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
	"strconv"
)

type Config struct {
	AMQPURL      string // где живёт RabbitMQ
	GRPCAddr     string // адрес gRPC-сервера (Notify/Stats)
	HTTPAddr     string // адрес служебных /health и /outbox
	DatabaseURL  string // DSN общей базы API (схема cine, таблица outbox_messages)
	Batch        int    // записей за один батч доставки
	PollMs       int    // период тика доставки (Notify будит раньше)
	BackoffCapMs int    // кэп паузы между попытками неудавшейся записи
}

// Load собирает конфиг из окружения; дефолты позволяют стартовать без .env
// на локельном брокере/стенде.
func Load() Config {
	return Config{
		AMQPURL:      env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		GRPCAddr:     env("GRPC_ADDR", ":8093"),
		HTTPAddr:     env("HTTP_ADDR", ":8094"),
		DatabaseURL:  env("DATABASE_URL", "postgres://cine:cine@localhost:15432/cine"),
		Batch:        envInt("RELAY_BATCH", 20),
		PollMs:       envInt("RELAY_POLL_MS", 500),
		BackoffCapMs: envInt("RELAY_BACKOFF_CAP_MS", 60000),
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

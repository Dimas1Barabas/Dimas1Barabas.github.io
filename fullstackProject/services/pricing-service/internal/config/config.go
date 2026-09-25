// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
	"strconv"
)

type Config struct {
	AMQPURL     string // где живёт RabbitMQ
	GRPCAddr    string // адрес gRPC-сервера цен
	HTTPAddr    string // адрес служебных /health, /prices, /demand
	Storage     string // memory | postgres — какой DemandStore-адаптер за портом
	DatabaseURL string // DSN postgres-адаптера (используется при STORAGE=postgres)
	MaxAttempts int    // попыток обработки события, дальше — parking
	RetryTTLMs  int    // сколько retry-очередь держит сообщение
}

// Load собирает конфиг из окружения; дефолты позволяют стартовать
// без .env на локальном брокере.
func Load() Config {
	return Config{
		AMQPURL:     env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		GRPCAddr:    env("GRPC_ADDR", ":8088"),
		HTTPAddr:    env("HTTP_ADDR", ":8089"),
		Storage:     env("STORAGE", "memory"),
		DatabaseURL: env("DATABASE_URL", "postgres://cine:cine@localhost:15432/cine_prices"),
		MaxAttempts: envInt("RETRY_MAX_ATTEMPTS", 3),
		RetryTTLMs:  envInt("RETRY_TTL_MS", 5000),
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

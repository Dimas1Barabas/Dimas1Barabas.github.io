// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
	"strconv"
)

type Config struct {
	AMQPURL     string // где живёт RabbitMQ
	HTTPAddr    string // адрес /health /stats /notifications
	BufferSize  int    // сколько последних уведомлений держит память
	MaxAttempts int    // попыток обработки, дальше — parking
	RetryTTLMs  int    // сколько retry-очередь держит сообщение
}

// Load собирает конфиг из окружения; дефолты позволяют стартовать
// без .env на локальном брокере.
func Load() Config {
	return Config{
		AMQPURL:     env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		HTTPAddr:    env("HTTP_ADDR", ":8080"),
		BufferSize:  envInt("BUFFER_SIZE", 500),
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

// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
	"strconv"
)

type Config struct {
	AMQPURL     string // где живёт RabbitMQ
	GRPCAddr    string // адрес gRPC-сервера напоминаний
	HTTPAddr    string // адрес служебных /health и /reminders
	Storage     string // memory | postgres — какой ReminderStore-адаптер за портом
	DatabaseURL string // DSN postgres-адаптера (используется при STORAGE=postgres)
	LeadMinutes int    // за сколько минут до сеанса напоминать
	TickSeconds int    // период проверки наступивших напоминаний
}

// Load собирает конфиг из окружения; дефолты позволяют стартовать
// без .env на локальном брокере.
func Load() Config {
	return Config{
		AMQPURL:     env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		GRPCAddr:    env("GRPC_ADDR", ":8086"),
		HTTPAddr:    env("HTTP_ADDR", ":8087"),
		Storage:     env("STORAGE", "memory"),
		DatabaseURL: env("DATABASE_URL", "postgres://cine:cine@localhost:15432/cine_reminders"),
		LeadMinutes: envInt("REMINDER_LEAD_MINUTES", 120),
		TickSeconds: envInt("REMINDER_TICK_SECONDS", 30),
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

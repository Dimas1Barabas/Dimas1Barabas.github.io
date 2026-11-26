// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	AMQPURL             string        // где живёт RabbitMQ
	HTTPAddr            string        // адрес витрины /subscriptions, /deliveries, /health
	Storage             string        // memory | postgres — какой адаптер за портами
	DatabaseURL         string        // DSN postgres-адаптера (используется при STORAGE=postgres)
	MaxAttempts         int           // попыток обработки события брокера, дальше — parking
	RetryTTLMs          int           // сколько retry-очередь держит сообщение
	DeliveryMax         int           // попыток доставки партнёру, дальше — DLQ витрины
	DeliveryBaseBackoff time.Duration // пауза после первой неудачи, дальше — экспонента
	TickEvery           time.Duration // период фонового такта доставки
	Batch               int           // доставок за один такт
	HTTPTimeout         time.Duration // таймаут одного POST партнёру
}

// Load собирает конфиг из окружения; дефолты позволяют стартовать
// без .env на локальном брокере. Стенды ускоряют ретраи: DeliveryBaseBackoff
// 2 c и Max 5 — вебхук доходит за десятки секунд, e2e не ждёт минут.
func Load() Config {
	return Config{
		AMQPURL:             env("AMQP_URL", "amqp://guest:guest@localhost:5672/"),
		HTTPAddr:            env("HTTP_ADDR", ":8102"),
		Storage:             env("STORAGE", "memory"),
		DatabaseURL:         env("DATABASE_URL", "postgres://cine:cine@localhost:15432/cine_postman"),
		MaxAttempts:         envInt("RETRY_MAX_ATTEMPTS", 3),
		RetryTTLMs:          envInt("RETRY_TTL_MS", 5000),
		DeliveryMax:         envInt("DELIVERY_MAX_ATTEMPTS", 5),
		DeliveryBaseBackoff: time.Duration(envInt("DELIVERY_BACKOFF_MS", 2000)) * time.Millisecond,
		TickEvery:           time.Duration(envInt("TICK_MS", 1000)) * time.Millisecond,
		Batch:               envInt("DELIVERY_BATCH", 25),
		HTTPTimeout:         time.Duration(envInt("DELIVERY_HTTP_TIMEOUT_MS", 5000)) * time.Millisecond,
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

// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
	"strconv"
)

type Config struct {
	GRPCAddr    string // адрес gRPC-сервера лимитов
	HTTPAddr    string // адрес служебных /health, /buckets
	Storage     string // memory | postgres — какой BucketStore-адаптер за портом
	DatabaseURL string // DSN postgres-адаптера (используется при STORAGE=postgres)

	// Политики действий: пределы в минуту. «N в минуту» = ёмкость N
	// и долив N/60 в секунду (domain.PolicyOf) — burst-дружелюбно:
	// двойной клик не наказываем, наказываем спам.
	RateBookingsPerMin int // POST /bookings на пользователя
	RateLoginPerMin    int // POST /auth/login на email (брутфорс)
}

// Load собирает конфиг из окружения; дефолты — честные продуктовые
// лимиты (стенд compose может отпускать их шире под e2e).
func Load() Config {
	return Config{
		GRPCAddr:           env("GRPC_ADDR", ":8090"),
		HTTPAddr:           env("HTTP_ADDR", ":8091"),
		Storage:            env("STORAGE", "memory"),
		DatabaseURL:        env("DATABASE_URL", "postgres://cine:cine@localhost:15432/cine_ratekeeper"),
		RateBookingsPerMin: envInt("RATE_BOOKINGS_PER_MIN", 10),
		RateLoginPerMin:    envInt("RATE_LOGIN_PER_MIN", 5),
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

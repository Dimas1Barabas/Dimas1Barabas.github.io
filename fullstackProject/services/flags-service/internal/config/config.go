// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
)

type Config struct {
	GRPCAddr    string // адрес gRPC-сервера флагов
	HTTPAddr    string // адрес служебных /health, /flags
	Storage     string // memory | postgres — какой FlagStore-адаптер за портом
	DatabaseURL string // DSN postgres-адаптера (используется при STORAGE=postgres)
}

// Load собирает конфиг из окружения; дефолты — адреса стенда compose
// (хост-мапинги 18095/18096 прокидывают их наружу для grpcurl).
func Load() Config {
	return Config{
		GRPCAddr:    env("GRPC_ADDR", ":8095"),
		HTTPAddr:    env("HTTP_ADDR", ":8096"),
		Storage:     env("STORAGE", "memory"),
		DatabaseURL: env("DATABASE_URL", "postgres://cine:cine@localhost:15432/cine_flags"),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

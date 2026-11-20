// Package config — настройки из окружения. Конфиг живёт вне гексагона:
// это данные для composition root, а не часть домена.
package config

import (
	"os"
	"strconv"
)

type Config struct {
	GRPCAddr    string // адрес gRPC-сервера скоринга
	HTTPAddr    string // адрес служебных /health, /decisions
	Storage     string // memory | postgres — какой DecisionStore за портом
	DatabaseURL string // DSN postgres-адаптера (используется при STORAGE=postgres)

	// Пороги вердиктов: скор ниже review — allow, между review и block —
	// очередь ревью, от block — отказ. Веса правил — код (меняются реже
	// и проверяются векторами), пороги — окружение: тест-стенд может
	// сузить их для детерминированных сценариев.
	ReviewScore int
	BlockScore  int
}

// Load собирает конфиг из окружения; дефолты подобраны под правила:
// свежий счёт с одной бронью (30) — allow, пять броней подряд (55) —
// review, конвейер с кучей мест (75) — block.
func Load() Config {
	return Config{
		GRPCAddr:    env("GRPC_ADDR", ":8092"),
		HTTPAddr:    env("HTTP_ADDR", ":8093"),
		Storage:     env("STORAGE", "memory"),
		DatabaseURL: env("DATABASE_URL", "postgres://cine:cine@localhost:15432/cine_detective"),
		ReviewScore: envInt("FRAUD_REVIEW_SCORE", 40),
		BlockScore:  envInt("FRAUD_BLOCK_SCORE", 70),
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

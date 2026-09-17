package config

import (
	"testing"
	"time"
)

// Env-парсеры: дефолт без переменной, значение — с ней, мусор — снова дефолт.
func TestLoadEnvParsers(t *testing.T) {
	t.Run("дефолты", func(t *testing.T) {
		cfg := Load()
		if cfg.HTTPAddr != ":8081" {
			t.Fatalf("HTTPAddr = %q, want :8081", cfg.HTTPAddr)
		}
		if cfg.MinLatency != 1200*time.Millisecond {
			t.Fatalf("MinLatency = %v, want 1.2s", cfg.MinLatency)
		}
		if cfg.SuccessRate != 0.9 {
			t.Fatalf("SuccessRate = %v, want 0.9", cfg.SuccessRate)
		}
		if cfg.MaxAttempts != 3 {
			t.Fatalf("MaxAttempts = %d, want 3", cfg.MaxAttempts)
		}
	})

	t.Run("переопределение", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", ":9090")
		t.Setenv("PROCESS_MIN_MS", "100")
		t.Setenv("SUCCESS_RATE", "0.5")
		t.Setenv("RETRY_MAX_ATTEMPTS", "7")

		cfg := Load()
		if cfg.HTTPAddr != ":9090" {
			t.Fatalf("HTTPAddr = %q, want :9090", cfg.HTTPAddr)
		}
		if cfg.MinLatency != 100*time.Millisecond {
			t.Fatalf("MinLatency = %v, want 100ms", cfg.MinLatency)
		}
		if cfg.SuccessRate != 0.5 {
			t.Fatalf("SuccessRate = %v, want 0.5", cfg.SuccessRate)
		}
		if cfg.MaxAttempts != 7 {
			t.Fatalf("MaxAttempts = %d, want 7", cfg.MaxAttempts)
		}
	})

	t.Run("мусор в числе — дефолт", func(t *testing.T) {
		t.Setenv("PROCESS_MIN_MS", "не число")
		if got := envInt("PROCESS_MIN_MS", 42); got != 42 {
			t.Fatalf("envInt(мусор) = %d, want 42", got)
		}
	})
}

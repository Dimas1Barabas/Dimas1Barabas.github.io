package config

import "testing"

// Env-парсеры: дефолт без переменной, значение — с ней, мусор — снова дефолт.
func TestLoadEnvParsers(t *testing.T) {
	t.Run("дефолты", func(t *testing.T) {
		cfg := Load()
		if cfg.AMQPURL != "amqp://guest:guest@localhost:5672/" {
			t.Fatalf("AMQPURL = %q", cfg.AMQPURL)
		}
		if cfg.HTTPAddr != ":8080" {
			t.Fatalf("HTTPAddr = %q, want :8080", cfg.HTTPAddr)
		}
		if cfg.Storage != "memory" {
			t.Fatalf("Storage = %q, want memory (стенд без БД не падает)", cfg.Storage)
		}
		if cfg.DatabaseURL != "postgres://cine:cine@localhost:15432/cine_notifications" {
			t.Fatalf("DatabaseURL = %q", cfg.DatabaseURL)
		}
		if cfg.BufferSize != 500 {
			t.Fatalf("BufferSize = %d, want 500", cfg.BufferSize)
		}
		if cfg.MaxAttempts != 3 {
			t.Fatalf("MaxAttempts = %d, want 3", cfg.MaxAttempts)
		}
		if cfg.RetryTTLMs != 5000 {
			t.Fatalf("RetryTTLMs = %d, want 5000", cfg.RetryTTLMs)
		}
	})

	t.Run("переопределение", func(t *testing.T) {
		t.Setenv("AMQP_URL", "amqp://broker:5673/")
		t.Setenv("STORAGE", "postgres")
		t.Setenv("DATABASE_URL", "postgres://cine:cine@db:5432/other")
		t.Setenv("BUFFER_SIZE", "10")

		cfg := Load()
		if cfg.AMQPURL != "amqp://broker:5673/" {
			t.Fatalf("AMQPURL = %q", cfg.AMQPURL)
		}
		if cfg.Storage != "postgres" {
			t.Fatalf("Storage = %q, want postgres", cfg.Storage)
		}
		if cfg.DatabaseURL != "postgres://cine:cine@db:5432/other" {
			t.Fatalf("DatabaseURL = %q", cfg.DatabaseURL)
		}
		if cfg.BufferSize != 10 {
			t.Fatalf("BufferSize = %d, want 10", cfg.BufferSize)
		}
	})

	t.Run("мусор в числе — дефолт", func(t *testing.T) {
		t.Setenv("BUFFER_SIZE", "не число")
		if got := envInt("BUFFER_SIZE", 42); got != 42 {
			t.Fatalf("envInt(мусор) = %d, want 42", got)
		}
	})
}

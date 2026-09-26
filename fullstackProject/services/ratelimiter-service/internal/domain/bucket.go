// Package domain — арифметика token-корзины «Привратника»: чистые
// функции без знания о транспортах и хранилищах.
package domain

import (
	"math"
	"time"
)

// Bucket — состояние корзины клиента: остаток токенов и момент
// последнего решения. nil-корзина = клиента видим впервые:
// корзина считается полной (capacity). LastTaken — вердикт последней
// проверки: остаток 0.4 после списания неотличим от отказа с 0.4,
// витрине нужен явный след.
type Bucket struct {
	Tokens    float64
	UpdatedAt time.Time
	LastTaken bool
}

// Decision — вердикт «снять токен».
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration // 0 при Allowed
	Remaining  float64       // дробные токены после решения
}

// Check — token bucket одним шагом: долив по прошедшему времени,
// снятие одного токена, если набрался целый. Отказ токен не списывает,
// но момент UpdatedAt двигает — долив считается от последней проверки.
// Зеркало этой арифметики живёт в демо-движке витрины
// (apps/web demoEngine.takeToken) — векторы совпадают.
func Check(b *Bucket, now time.Time, capacity, refillPerSec float64) (Bucket, Decision) {
	tokens, updated := capacity, now
	if b != nil {
		tokens, updated = b.Tokens, b.UpdatedAt
	}
	elapsed := now.Sub(updated).Seconds()
	if elapsed < 0 {
		elapsed = 0 // часы дрейфнули назад — не даём корзине «вырасти»
	}
	// простой не пополняет корзину выше ёмкости: burst не копится
	tokens = math.Min(capacity, tokens+elapsed*refillPerSec)

	if tokens >= 1 {
		next := Bucket{Tokens: tokens - 1, UpdatedAt: now, LastTaken: true}
		return next, Decision{Allowed: true, Remaining: next.Tokens}
	}
	next := Bucket{Tokens: tokens, UpdatedAt: now, LastTaken: false}
	return next, Decision{
		Allowed:    false,
		RetryAfter: RetryAfter(tokens, refillPerSec),
		Remaining:  tokens,
	}
}

// RetryAfter — сколько ждать до целого токена при остатке tokens:
// округляем вверх до миллисекунды, минимум 1 мс (делить на refill
// нельзя — нулевой долив означал бы вечное ожидание, конфиг не пускает).
func RetryAfter(tokens, refillPerSec float64) time.Duration {
	ms := math.Ceil((1 - tokens) / refillPerSec * 1000)
	if ms < 1 {
		ms = 1
	}
	return time.Duration(ms) * time.Millisecond
}

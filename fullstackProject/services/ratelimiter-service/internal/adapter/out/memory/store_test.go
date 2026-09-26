package memory

import (
	"context"
	"testing"
	"time"

	"ratelimiter-service/internal/domain"
)

func TestTakeBurstThenRefuse(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	p := domain.PolicyOf(10)

	for i := 0; i < 10; i++ {
		taken, _, err := s.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
		if err != nil || !taken {
			t.Fatalf("бронь %d: taken=%v err=%v", i+1, taken, err)
		}
	}
	taken, remaining, err := s.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
	if err != nil {
		t.Fatalf("не ждали ошибку: %v", err)
	}
	if taken || remaining >= 1 {
		t.Fatalf("11-я подряд должна отказать: taken=%v remaining=%v", taken, remaining)
	}

	// отказ не списывает: следующий Take мгновенно тоже откажет
	taken2, _, _ := s.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
	if taken2 {
		t.Fatalf("повторный отказ не должен находить целый токен")
	}
}

func TestTakeRefillReturnsToken(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	p := domain.PolicyOf(10) // долив 1 токен за 6 секунд

	// выжигаем корзину и отматываем время последней проверки назад —
	// имитируем паузу: прямой доступ к карте дешевле патча часов
	id := string(domain.ActionAuthLogin) + ":bot@example.local"
	s.buckets[id] = domain.Bucket{
		Tokens:    0,
		UpdatedAt: time.Now().Add(-2 * time.Minute),
	}
	taken, _, err := s.Take(ctx, domain.ActionAuthLogin, "bot@example.local", p)
	if err != nil || !taken {
		t.Fatalf("после паузы корзина полная: taken=%v err=%v", taken, err)
	}
}

func TestListBucketsShowsVerdict(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	p := domain.PolicyOf(2)

	s.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
	s.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
	taken, _, _ := s.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
	if taken {
		t.Fatalf("третья подряд при ёмкости 2 — отказ")
	}

	rows, err := s.ListBuckets(ctx)
	if err != nil {
		t.Fatalf("витрина: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("корзин в витрине = %d, ожидали 1", len(rows))
	}
	if rows[0].Action != "bookings.create" || rows[0].Key != "u-1" {
		t.Fatalf("строка витрины = %+v", rows[0])
	}
	if rows[0].Taken {
		t.Fatalf("последний вердикт — отказ, витрина должна его показывать")
	}
}

func TestTakeConcurrentSameBucket(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	p := domain.PolicyOf(10)

	// 50 горутин бьют одну корзину: снять должны ровно ёмкость
	// (плюс-минус долив, но не больше целого сверху)
	results := make(chan bool, 50)
	for i := 0; i < 50; i++ {
		go func() {
			taken, _, _ := s.Take(ctx, domain.ActionBookingsCreate, "u-1", p)
			results <- taken
		}()
	}
	allowed := 0
	for i := 0; i < 50; i++ {
		if <-results {
			allowed++
		}
	}
	if allowed < 10 || allowed > 11 { // 10 burst + возможный капля долива
		t.Fatalf("снято %d токенов, ожидали 10–11", allowed)
	}
}

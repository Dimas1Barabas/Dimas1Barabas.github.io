package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"ratelimiter-service/internal/domain"
)

// fakeStore — стаб порта: повторяет арифметику Check, но позволяет
// подменять ошибку хранилища.
type fakeStore struct {
	buckets map[string]domain.Bucket
	err     error
}

func (f *fakeStore) Take(_ context.Context, action domain.Action, key string, p domain.Policy) (bool, float64, error) {
	if f.err != nil {
		return false, 0, f.err
	}
	id := string(action) + ":" + key
	var current *domain.Bucket
	if b, ok := f.buckets[id]; ok {
		current = &b
	}
	next, d := domain.Check(current, time.Now(), p.Capacity, p.RefillPerSec)
	f.buckets[id] = next
	return d.Allowed, d.Remaining, nil
}

func (f *fakeStore) ListBuckets(_ context.Context) ([]domain.BucketRecord, error) {
	return nil, nil
}

func policies() map[domain.Action]domain.Policy {
	return map[domain.Action]domain.Policy{
		domain.ActionBookingsCreate: domain.PolicyOf(10),
		domain.ActionAuthLogin:      domain.PolicyOf(5),
	}
}

func TestCheckAllowsBurst(t *testing.T) {
	l := NewLimiter(&fakeStore{buckets: map[string]domain.Bucket{}}, policies())
	for i := 0; i < 10; i++ {
		d, err := l.Check(context.Background(), "bookings.create", "user-1")
		if err != nil || !d.Allowed {
			t.Fatalf("бронь %d: %+v / %v", i+1, d, err)
		}
	}
	d, err := l.Check(context.Background(), "bookings.create", "user-1")
	if err != nil {
		t.Fatalf("не ждали ошибку: %v", err)
	}
	if d.Allowed {
		t.Fatalf("11-я подряд бронь должна быть отказана")
	}
	if d.RetryAfter <= 0 {
		t.Fatalf("в отказе нужен retryAfter: %+v", d)
	}
}

func TestCheckSeparateKeysAndActions(t *testing.T) {
	l := NewLimiter(&fakeStore{buckets: map[string]domain.Bucket{}}, policies())
	ctx := context.Background()

	// выжигаем корзину брони первого клиента
	for i := 0; i < 10; i++ {
		if d, err := l.Check(ctx, "bookings.create", "user-1"); err != nil || !d.Allowed {
			t.Fatalf("бронь %d: %+v / %v", i+1, d, err)
		}
	}
	// другой клиент и другое действие — свои корзины
	if d, err := l.Check(ctx, "bookings.create", "user-2"); err != nil || !d.Allowed {
		t.Fatalf("чужая корзина не должна пострадать: %+v / %v", d, err)
	}
	if d, err := l.Check(ctx, "auth.login", "user-1@example.local"); err != nil || !d.Allowed {
		t.Fatalf("у действия своя корзина: %+v / %v", d, err)
	}
}

func TestCheckUnknownAction(t *testing.T) {
	l := NewLimiter(&fakeStore{buckets: map[string]domain.Bucket{}}, policies())
	if _, err := l.Check(context.Background(), "reviews.create", "user-1"); !errors.Is(err, domain.ErrUnknownAction) {
		t.Fatalf("ожидали ErrUnknownAction, получили %v", err)
	}
}

func TestCheckStoreErrorPropagates(t *testing.T) {
	boom := errors.New("хранилище мертво")
	l := NewLimiter(&fakeStore{err: boom}, policies())
	if _, err := l.Check(context.Background(), "bookings.create", "user-1"); !errors.Is(err, boom) {
		t.Fatalf("ошибка хранилища должна всплыть вызывающему: %v", err)
	}
}

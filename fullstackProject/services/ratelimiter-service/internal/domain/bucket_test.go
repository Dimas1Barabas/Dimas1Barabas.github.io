package domain

import (
	"math"
	"testing"
	"time"
)

func TestCheck(t *testing.T) {
	base := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)

	t.Run("первый визит — корзина полная, токен снят", func(t *testing.T) {
		next, d := Check(nil, base, 10, 10.0/60)
		if !d.Allowed {
			t.Fatalf("ожидали allowed, получили %+v", d)
		}
		if next.Tokens != 9 {
			t.Fatalf("остаток = %v, ожидали 9", next.Tokens)
		}
		if d.Remaining != 9 || d.RetryAfter != 0 {
			t.Fatalf("решение = %+v", d)
		}
		if !next.UpdatedAt.Equal(base) {
			t.Fatalf("updatedAt должен стать моментом проверки")
		}
	})

	t.Run("простой клампится в ёмкость — burst не копится", func(t *testing.T) {
		b := Bucket{Tokens: 9.5, UpdatedAt: base.Add(-time.Hour)}
		next, d := Check(&b, base, 10, 10.0/60)
		if !d.Allowed || next.Tokens != 9 {
			t.Fatalf("после часа простоя корзина полная: %+v / %+v", next, d)
		}
	})

	t.Run("долив равномерный: 36 секунд ≈ 6 токенов при 10/мин", func(t *testing.T) {
		b := Bucket{Tokens: 0, UpdatedAt: base}
		_, d := Check(&b, base.Add(36*time.Second), 10, 10.0/60)
		if !d.Allowed {
			t.Fatalf("за 36 c должно набрать 6 токенов: %+v", d)
		}
	})

	t.Run("отказ не списывает и даёт retryAfter", func(t *testing.T) {
		b := Bucket{Tokens: 0.5, UpdatedAt: base}
		next, d := Check(&b, base, 10, 10.0/60)
		if d.Allowed {
			t.Fatalf("полтокена не хватает на списание")
		}
		if next.Tokens != 0.5 {
			t.Fatalf("отказ списал токен: %+v", next)
		}
		// (1 − 0.5) / (10/60) = 3 секунды
		if d.RetryAfter != 3*time.Second {
			t.Fatalf("retryAfter = %v, ожидали 3 c", d.RetryAfter)
		}
	})

	t.Run("часы дрейфнули назад — долива нет", func(t *testing.T) {
		b := Bucket{Tokens: 1, UpdatedAt: base}
		_, d := Check(&b, base.Add(-time.Minute), 10, 10.0/60)
		if !d.Allowed {
			t.Fatalf("токен целый, отказ возможен только из-за долива: %+v", d)
		}
	})

	t.Run("лимит 10/мин: одиннадцатый подряд — отказ с честным ожиданием", func(t *testing.T) {
		var b *Bucket
		for i := 0; i < 10; i++ {
			next, d := Check(b, base.Add(time.Duration(i)*time.Millisecond), 10, 10.0/60)
			if !d.Allowed {
				t.Fatalf("бронь %d должна проходить (burst 10)", i+1)
			}
			b = &next
		}
		_, d := Check(b, base.Add(10*time.Millisecond), 10, 10.0/60)
		if d.Allowed {
			t.Fatalf("11-я подряд бронь за секунды должна быть отказана")
		}
		// остаток ≈ долив за 10 мс ≈ 0.0017, ждать почти целый токен: ~6 c
		if d.RetryAfter < 5*time.Second || d.RetryAfter > 7*time.Second {
			t.Fatalf("retryAfter = %v, ожидали ~6 c", d.RetryAfter)
		}
	})
}

func TestRetryAfter(t *testing.T) {
	cases := []struct {
		name          string
		tokens        float64
		refillPerSec  float64
		want          time.Duration
	}{
		{"целый дефицит при 5/мин", 0, 5.0 / 60, 12 * time.Second},
		{"половина токена при 10/мин", 0.5, 10.0 / 60, 3 * time.Second},
		{"почти целый — минимум 1 мс", 0.9999, 1000, time.Millisecond},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := RetryAfter(c.tokens, c.refillPerSec)
			if math.Abs(float64(got-c.want)) > float64(time.Millisecond) {
				t.Fatalf("RetryAfter = %v, ожидали %v", got, c.want)
			}
		})
	}
	if RetryAfter(0, 1) < time.Millisecond {
		t.Fatalf("минимум 1 мс")
	}
}

func TestPolicyOf(t *testing.T) {
	p := PolicyOf(10)
	if p.Capacity != 10 || p.LimitPerMin != 10 {
		t.Fatalf("политика = %+v", p)
	}
	if math.Abs(p.RefillPerSec-10.0/60) > 1e-9 {
		t.Fatalf("долив = %v, ожидали 10/60 в секунду", p.RefillPerSec)
	}
}

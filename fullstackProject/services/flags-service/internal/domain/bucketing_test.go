package domain

import (
	"fmt"
	"testing"
)

// Векторы сгенерированы один раз и вшиты сюда и в TS-зеркало
// (apps/api/src/flags): значения должны совпасть на обеих сторонах.
func TestBucketVectors(t *testing.T) {
	vectors := []struct {
		key    string
		entity string
		bucket int
	}{
		{"checkout.new_flow", "user-1", 99},
		{"checkout.new_flow", "user-2", 10},
		{"checkout.new_flow", "user-3", 21},
		{"demo.audience", "user-1", 47},
		{"demo.audience", "user-42", 6},
		{"booking.qr_v2", "u-7@example.local", 58},
	}
	for _, v := range vectors {
		if got := Bucket(v.key, v.entity); got != v.bucket {
			t.Fatalf("Bucket(%q, %q) = %d, зафиксирован %d", v.key, v.entity, got, v.bucket)
		}
	}
}

func TestBucketRangeAndDeterminism(t *testing.T) {
	for i := 0; i < 1000; i++ {
		entity := fmt.Sprintf("entity-%d", i)
		b := Bucket("some.flag", entity)
		if b < 0 || b > 99 {
			t.Fatalf("бакет вне 0..99: %d", b)
		}
		if again := Bucket("some.flag", entity); again != b {
			t.Fatalf("бакет «мигает»: %d против %d", b, again)
		}
	}
}

// Раскатка честная: доля сущностей внутри p% ≈ p. Проверяем по факту
// на 100k сущностей для p=50 и p=10: допуск ±1.5п.п. — FNV-1a
// на последовательных строках даёт равномерное распределение.
func TestBucketDistribution(t *testing.T) {
	for _, p := range []int{50, 10} {
		inside := 0
		const total = 100_000
		for i := 0; i < total; i++ {
			if Bucket("dist.flag", fmt.Sprintf("user-%d", i)) < p {
				inside++
			}
		}
		got := float64(inside) / float64(total) * 100
		if got < float64(p)-1.5 || got > float64(p)+1.5 {
			t.Fatalf("раскатка %d%%: факт %.2f%% — распределение не равномерно", p, got)
		}
	}
}

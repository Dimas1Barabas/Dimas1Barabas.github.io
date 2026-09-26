package domain

import (
	"context"
	"time"
)

// BucketStore — порт хранилища Привратника (память или Postgres).
// Take атомарен: долив + попытка списания одним шагом, включая
// первый визит (строки ещё нет — корзина полная). Возврат — вердикт
// и остаток; retryAfter домен досчитывает сам, он знает политику.
type BucketStore interface {
	Take(ctx context.Context, action Action, key string, p Policy) (taken bool, remaining float64, err error)
	ListBuckets(ctx context.Context) ([]BucketRecord, error)
}

// BucketRecord — строка витрины /buckets: как дышат корзины.
type BucketRecord struct {
	Action    string
	Key       string
	Tokens    float64
	Taken     bool // вердикт последней проверки
	UpdatedAt time.Time
}

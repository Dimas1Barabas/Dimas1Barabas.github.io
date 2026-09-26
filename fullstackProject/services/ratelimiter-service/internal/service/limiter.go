// Package service — use-case'ы Привратника: оркестрация домена
// и хранилища без знания о транспортах.
package service

import (
	"context"

	"ratelimiter-service/internal/domain"
)

// Limiter — применение политик к действиям API: гвард спрашивает
// один токен корзины, вердикт и остаток возвращает.
type Limiter struct {
	store    domain.BucketStore
	policies map[domain.Action]domain.Policy
}

// NewLimiter собирает лимитер над хранилищем; политики передаются
// снаружи (composition root читает их из окружения).
func NewLimiter(store domain.BucketStore, policies map[domain.Action]domain.Policy) *Limiter {
	return &Limiter{store: store, policies: policies}
}

// Check — снять токен корзины действия для ключа (user id / email / ip).
// Ошибка хранилища возвращается вызывающему: gRPC-слой отличит её
// от неизвестного действия (InvalidArgument) и ответит Internal —
// а API по своей философии погасит даже это fallback'ом (fail-open).
func (l *Limiter) Check(ctx context.Context, action, key string) (domain.Decision, error) {
	a := domain.Action(action)
	p, ok := l.policies[a]
	if !ok {
		return domain.Decision{}, domain.ErrUnknownAction
	}
	taken, remaining, err := l.store.Take(ctx, a, key, p)
	if err != nil {
		return domain.Decision{}, err
	}
	if taken {
		return domain.Decision{Allowed: true, Remaining: remaining}, nil
	}
	// retryAfter считаем из остатка и политики: хранилище вернуло
	// только арифметику корзины, темп долива знает домен
	return domain.Decision{
		Allowed:    false,
		Remaining:  remaining,
		RetryAfter: domain.RetryAfter(remaining, p.RefillPerSec),
	}, nil
}

// Policies — таблица политик (для ответов: limit/capacity).
func (l *Limiter) Policies() map[domain.Action]domain.Policy {
	return l.policies
}

// ListBuckets — витрина /buckets: как дышат корзины.
func (l *Limiter) ListBuckets(ctx context.Context) ([]domain.BucketRecord, error) {
	return l.store.ListBuckets(ctx)
}

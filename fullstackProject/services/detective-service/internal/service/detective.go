// Package service — use-case'ы Детектива: оркестрация домена и
// хранилища решений без знания о транспортах.
package service

import (
	"context"

	"detective-service/internal/domain"
)

// Detective — применение правил к фактам брони: решение считается
// доменом, хранилище ведёт его жизненный цикл (идемпотентность по
// booking_id, очередь ревью).
type Detective struct {
	store      domain.DecisionStore
	thresholds domain.Thresholds
}

// NewDetective собирает сервис над хранилищем; пороги передаются
// снаружи (composition root читает их из окружения).
func NewDetective(store domain.DecisionStore, thresholds domain.Thresholds) *Detective {
	return &Detective{store: store, thresholds: thresholds}
}

// Score — решение по фактам: посчитать и записать. Повторный вызов с
// тем же booking_id возвращает записанное решение — вердикт не
// пересматривается задним числом.
func (d *Detective) Score(ctx context.Context, f domain.Facts) (domain.DecisionRecord, error) {
	return d.store.Save(ctx, domain.Score(f, d.thresholds))
}

// Resolve — решение человека по брони из очереди ревью: неизвестное
// действие отсеиваем здесь, гонку двух админов и отсутствие решения
// различает хранилище.
func (d *Detective) Resolve(ctx context.Context, bookingID, action, by string) (domain.DecisionRecord, error) {
	a := domain.ResolveAction(action)
	if _, err := domain.ResolveStatus(a); err != nil {
		return domain.DecisionRecord{}, err
	}
	return d.store.Resolve(ctx, bookingID, a, by)
}

// Get — одно решение (админ-действие сначала смотрит, что решает).
func (d *Detective) Get(ctx context.Context, bookingID string) (domain.DecisionRecord, error) {
	return d.store.Get(ctx, bookingID)
}

// List — витрина решений: пустой статус — все, свежие сверху.
func (d *Detective) List(ctx context.Context, status string, limit int) ([]domain.DecisionRecord, error) {
	return d.store.List(ctx, domain.Status(status), limit)
}

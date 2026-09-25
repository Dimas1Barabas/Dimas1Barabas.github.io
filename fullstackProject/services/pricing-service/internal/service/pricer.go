// Package service — use-case'ы Тарификатора: квот цены по gRPC
// и ведение проекции спроса событиями из RabbitMQ.
package service

import (
	"context"
	"log"
	"time"

	"pricing-service/internal/domain"
)

// Pricer — use-case ценообразования: спрос читает из проекции,
// цену считает домен, расчёт попадает в историю витрины.
type Pricer struct {
	store domain.DemandStore
}

func NewPricer(store domain.DemandStore) *Pricer {
	return &Pricer{store: store}
}

// QuoteRequest — вход квота: кто спрашивает знает расписание и зал,
// спрос знает только Тарификатор (события брони — его вход).
type QuoteRequest struct {
	SessionID    string
	SessionAt    time.Time
	BasePriceRub int
	Capacity     int
}

// Quote — цена места сеанса. Спрос unavailable (сбой хранилища) —
// честная ошибка: вызывающий ответит fallback'ом на базовую цену.
func (p *Pricer) Quote(ctx context.Context, req QuoteRequest) (domain.Quote, error) {
	occupied, err := p.store.Demand(ctx, req.SessionID)
	if err != nil {
		return domain.Quote{}, err
	}
	quote, err := domain.ComputeQuote(req.SessionAt, req.BasePriceRub, occupied, req.Capacity)
	if err != nil {
		return domain.Quote{}, err
	}
	// история квотов — витрина, а не бухгалтерия: сбой записи не должен
	// портить цену, следующая запись её догонит
	if err := p.store.LogQuote(ctx, req.SessionID, quote); err != nil {
		log.Printf("витрина квотов: запись по сеансу %s: %v", req.SessionID, err)
	}
	return quote, nil
}

// HandleHeld — бронь создана: места сеанса заняты. Валидацию проходит
// на границе (адаптер AMQP), сюда мусор не долетает.
func (p *Pricer) HandleHeld(ctx context.Context, sessionID, bookingID string, seats int) error {
	if sessionID == "" || bookingID == "" || seats <= 0 {
		return domain.ErrInvalidDemandEvent
	}
	if _, err := p.store.ApplyHeld(ctx, sessionID, bookingID, seats); err != nil {
		return err
	}
	return nil
}

// HandleReleased — места вернулись в продажу: истёк резерв, отмена,
// отказ платежа, возврат билетов.
func (p *Pricer) HandleReleased(ctx context.Context, sessionID, bookingID string, seats int) error {
	if sessionID == "" || bookingID == "" || seats <= 0 {
		return domain.ErrInvalidDemandEvent
	}
	if _, err := p.store.ApplyReleased(ctx, sessionID, bookingID, seats); err != nil {
		return err
	}
	return nil
}

// ListQuotes — витрина истории квотов (HTTP-стенд).
func (p *Pricer) ListQuotes(ctx context.Context) ([]domain.QuoteRecord, error) {
	return p.store.ListQuotes(ctx)
}

// ListDemand — витрина проекции спроса (HTTP-стенд).
func (p *Pricer) ListDemand(ctx context.Context) ([]domain.DemandRecord, error) {
	return p.store.ListDemand(ctx)
}

// Package service — use-case Курьера: батчи доставки по тику и по сигналу
// Notify от API, витрина Stats.
package service

import (
	"context"
	"sync/atomic"

	"outbox-relay/internal/domain"
	"outbox-relay/internal/logging"
)

// Relay — use-case: вынести pending-записи outbox в брокер.
type Relay struct {
	store     domain.Store
	pub       domain.Publisher
	batch     int
	notify    chan struct{}
	published atomic.Int64
	failed    atomic.Int64
}

// NewRelay собирает релей; batch < 1 считается 1.
func NewRelay(store domain.Store, pub domain.Publisher, batch int) *Relay {
	if batch < 1 {
		batch = 1
	}
	return &Relay{
		store:  store,
		pub:    pub,
		batch:  batch,
		notify: make(chan struct{}, 1),
	}
}

// Notify — сигнал «API закоммитил записи» (gRPC после COMMIT). Неблокирующий:
// занятый канал значит, тик уже разбужен и дорейт всё — сигналы сливаются.
func (r *Relay) Notify() bool {
	select {
	case r.notify <- struct{}{}:
		return true
	default:
		return false
	}
}

// Wake — канал сигнала для select в main рядом с тикером.
func (r *Relay) Wake() <-chan struct{} { return r.notify }

// Tick — один такт доставки: батчи, пока хвост не исчерпан (короткий
// батч — pending пуст). Ошибок наружу не бросает (вызывает main) —
// логирует: следующий тик повторит, записи не теряются.
func (r *Relay) Tick(ctx context.Context) {
	for {
		n, err := r.store.DeliverBatch(ctx, r.batch, r.deliver)
		if err != nil {
			logging.Errorf(ctx, "tick: батч доставки: %v (следующий тик повторит)", err)
			return
		}
		if n < r.batch {
			return
		}
	}
}

// deliver — одна доставка: успех считает published, провал — failed
// и возвращает ошибку стору (тот зафиксирует attempts+1 и NextDelay).
func (r *Relay) deliver(ctx context.Context, m domain.Message) error {
	if err := r.pub.Publish(ctx, m); err != nil {
		r.failed.Add(1)
		return err
	}
	r.published.Add(1)
	return nil
}

// Stats — витрина: pending-хвост из сторы + счётчики процесса.
func (r *Relay) Stats(ctx context.Context) (domain.Stats, error) {
	st, err := r.store.Stats(ctx)
	if err != nil {
		return domain.Stats{}, err
	}
	st.PublishedTotal = r.published.Load()
	st.FailedAttempts = r.failed.Load()
	return st, nil
}

// Package service — use-cases Бармена: приём заказа в очередь, кнопки
// «в работу / готов / выдан» на экране бара и отказ от отменённых.
// Переходы и публикация статусов — за одним интерфейсом, витрина и
// консьюмер зовут одни и те же сценарии.
package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"barman-service/internal/domain"
	"barman-service/internal/logging"
)

// Barman — use-cases сервиса. Save-then-publish: статус фиксируется
// локально, событие уходит следом; сбой публикации не теряет прогресс —
// повторный клик по кнопке увидит уже применённый статус и просто
// переопубликует событие (API применяет статусы монотонно).
type Barman struct {
	store domain.OrderStore
	pub   domain.StatusPublisher
	clock domain.Clock
}

func NewBarman(store domain.OrderStore, pub domain.StatusPublisher) *Barman {
	return &Barman{store: store, pub: pub, clock: systemClock{}}
}

// WithClock — подмена часов (тесты замораживают переходы).
func (b *Barman) WithClock(clock domain.Clock) *Barman {
	b.clock = clock
	return b
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

// Accept — bar.order.created: заказ в очередь (идемпотентно по OrderID,
// ределивери не сбрасывает прогресс и не плодит записей).
func (b *Barman) Accept(ctx context.Context, o domain.Order) error {
	if o.OrderID == "" {
		return errors.New("заказ без orderId")
	}
	o.Status = domain.StatusNew
	if o.CreatedAt.IsZero() {
		o.CreatedAt = b.clock.Now()
	}
	o.ChangedAt = o.CreatedAt
	if err := b.store.Upsert(ctx, o); err != nil {
		return fmt.Errorf("принять заказ %s: %w", o.OrderID, err)
	}
	logging.Infof(ctx, "заказ %s в очереди: %s (%s)",
		o.OrderID, o.Summary(), o.SessionLabel())
	return nil
}

// Cancel — bar.order.cancelled: убрать с доски. Неизвестный заказ — не
// ошибка (событие может обогнать created при ределивери): молча гасим.
// Публикации нет — отмена и её статус уже случились в API, Бармен
// только перестаёт готовить.
func (b *Barman) Cancel(ctx context.Context, orderID string) error {
	o, err := b.store.Get(ctx, orderID)
	if errors.Is(err, domain.ErrOrderNotFound) {
		logging.Warnf(ctx, "отмена неизвестного заказа %s — пропущена", orderID)
		return nil
	}
	if err != nil {
		return err
	}
	if err := o.Cancel(); err != nil {
		// READY/PICKED_UP API не отменяет; рассинхрон не роняем — лог
		logging.Warnf(ctx, "отмена заказа %s в статусе %s: %v", orderID, o.Status, err)
		return nil
	}
	o.ChangedAt = b.clock.Now()
	if err := b.store.Save(ctx, o); err != nil {
		return fmt.Errorf("снять заказ %s: %w", orderID, err)
	}
	logging.Infof(ctx, "заказ %s снят по отмене владельца", orderID)
	return nil
}

// transition — общий путь кнопок: применить переход (или репаблиш
// уже применённого), сохранить, опубликовать статус.
func (b *Barman) transition(ctx context.Context, orderID string, step func(*domain.Order) error) (domain.Order, error) {
	o, err := b.store.Get(ctx, orderID)
	if err != nil {
		return domain.Order{}, err
	}
	was := o.Status
	if err := step(&o); err != nil {
		return domain.Order{}, err
	}
	if o.Status != was {
		o.ChangedAt = b.clock.Now()
		if err := b.store.Save(ctx, o); err != nil {
			return domain.Order{}, fmt.Errorf("сохранить %s: %w", o.OrderID, err)
		}
		logging.Infof(ctx, "заказ %s: %s → %s", o.OrderID, was, o.Status)
	}
	// публикуем и при повторном клике — репаблиш сбойной доставки
	if err := b.pub.PublishStatus(ctx, o); err != nil {
		return o, fmt.Errorf("статус %s заказа %s не опубликован: %w", o.Status, o.OrderID, err)
	}
	return o, nil
}

// Start — кнопка «взять в работу» (NEW → PREPARING). Повторный клик по
// уже PREPARING-заказу репаблишит событие — витрина ретраит публикацию.
func (b *Barman) Start(ctx context.Context, orderID string) (domain.Order, error) {
	return b.transition(ctx, orderID, func(o *domain.Order) error {
		if o.Status == domain.StatusPreparing {
			return nil // идемпотентный репаблиш
		}
		return o.Start()
	})
}

// Ready — кнопка «готов» (PREPARING → READY): notification-service
// сразу шлёт «письмо» «ждём на стойке».
func (b *Barman) Ready(ctx context.Context, orderID string) (domain.Order, error) {
	return b.transition(ctx, orderID, func(o *domain.Order) error {
		if o.Status == domain.StatusReady {
			return nil
		}
		return o.Ready()
	})
}

// PickUp — кнопка «выдан» (READY → PICKED_UP).
func (b *Barman) PickUp(ctx context.Context, orderID string) (domain.Order, error) {
	return b.transition(ctx, orderID, func(o *domain.Order) error {
		if o.Status == domain.StatusPickedUp {
			return nil
		}
		return o.PickUp()
	})
}

// Board — срез очереди для экрана бара.
func (b *Barman) Board(ctx context.Context) (domain.Board, error) {
	return b.store.Board(ctx)
}

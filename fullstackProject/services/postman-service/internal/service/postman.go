// Package service — use-case'ы «Почтальона»: подписка партнёра,
// fan-out события в доставки и фоновая доставка тикером.
package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"postman-service/internal/domain"
	"postman-service/internal/logging"
)

// Postman — use-case'ы вебхуков: подписки, fan-out, доставка, витрина.
type Postman struct {
	subs        domain.SubscriptionsStore
	deliveries  domain.DeliveriesStore
	sender      domain.WebhookSender
	observer    domain.DeliveryObserver // nil в тестах — телеметрия опциональна
	maxAttempts int                     // попыток доставки до DLQ
	baseBackoff time.Duration           // пауза первой неудачи; дальше — экспонента
	batch       int                     // доставок за один такт тикера
	now         func() time.Time
}

// New собирает use-case'ы. maxAttempts <= 1 — сразу в DLQ при первой
// неудаче; baseBackoff — пауза после первой неудачи, каждая следующая
// вдвое больше (2 c → 4 → 8 …, потолок 5 минут).
func New(
	subs domain.SubscriptionsStore,
	deliveries domain.DeliveriesStore,
	sender domain.WebhookSender,
	observer domain.DeliveryObserver,
	maxAttempts int,
	baseBackoff time.Duration,
	batch int,
) *Postman {
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	if baseBackoff <= 0 {
		baseBackoff = 2 * time.Second
	}
	if batch < 1 {
		batch = 25
	}
	return &Postman{
		subs:        subs,
		deliveries:  deliveries,
		sender:      sender,
		observer:    observer,
		maxAttempts: maxAttempts,
		baseBackoff: baseBackoff,
		batch:       batch,
		now:         time.Now,
	}
}

// SetClock замораживает время в тестах.
func (p *Postman) SetClock(now func() time.Time) { p.now = now }

// backoff — пауза после n-й неудачи: base·2^(n-1), потолок 5 минут.
func (p *Postman) backoff(failedAttempts int) time.Duration {
	d := p.baseBackoff
	for i := 1; i < failedAttempts; i++ {
		d *= 2
		if d >= 5*time.Minute {
			return 5 * time.Minute
		}
	}
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

// Subscribe — завести подписку партнёра: URL обязателен (http/https),
// фильтр событий — из известных или пустой (все). Секрет генерируется
// здесь и показывается создателю ровно один раз: в хранилище он лежит,
// но витрина отдаёт только маску.
func (p *Postman) Subscribe(ctx context.Context, rawURL string, events []string) (domain.Subscription, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Host == "" {
		return domain.Subscription{}, fmt.Errorf("%w: URL партнёра должен быть http(s) с хостом, получено %q", domain.ErrInvalidSubscription, rawURL)
	}
	normalized := domain.NormalizeEvents(events)
	for _, e := range normalized {
		if !domain.IsValidEventType(e) {
			return domain.Subscription{}, fmt.Errorf("%w: неизвестный тип события %q (доступны: %s)",
				domain.ErrInvalidSubscription, e, strings.Join(domain.EventTypes, ", "))
		}
	}

	secret, err := randomHex(32) // 64 символа whsec_
	if err != nil {
		return domain.Subscription{}, fmt.Errorf("генерация секрета: %w", err)
	}
	id, err := randomHex(16)
	if err != nil {
		return domain.Subscription{}, fmt.Errorf("генерация id: %w", err)
	}

	sub := domain.Subscription{
		ID:        "whsub_" + id,
		URL:       parsed.String(),
		Secret:    "whsec_" + secret,
		Events:    normalized,
		Active:    true,
		CreatedAt: p.now(),
	}
	if err := p.subs.Add(ctx, sub); err != nil {
		return domain.Subscription{}, err
	}
	logging.Infof(ctx, "подписка %s на %s (события: %s)", sub.ID, sub.URL, eventsLabel(normalized))
	return sub, nil
}

// Unsubscribe — убрать подписку партнёра. Историю доставок не трогаем:
// витрина и DLQ остаются для разбора полётов.
func (p *Postman) Unsubscribe(ctx context.Context, id string) (bool, error) {
	return p.subs.Delete(ctx, id)
}

// Subscriptions — витрина подписок.
func (p *Postman) Subscriptions(ctx context.Context) ([]domain.Subscription, error) {
	return p.subs.List(ctx)
}

// HandleEvent — событие брокера → доставки. Подписки, которым событие
// подходит, получают по строке; идемпотентность сидит в хранилище
// (пара «подписка + событие»), ределивери брокера повторов не плодит.
func (p *Postman) HandleEvent(ctx context.Context, evt domain.Event) error {
	if !domain.IsValidEventType(evt.Type) {
		return fmt.Errorf("%w: неизвестный routing key %q", domain.ErrInvalidEvent, evt.Type)
	}
	if !json.Valid(evt.Payload) {
		return fmt.Errorf("%w: тело не JSON", domain.ErrInvalidEvent)
	}
	if evt.ID == "" {
		return fmt.Errorf("%w: пустой отпечаток события", domain.ErrInvalidEvent)
	}

	subs, err := p.subs.List(ctx)
	if err != nil {
		return err
	}
	now := p.now()
	batch := make([]domain.Delivery, 0, len(subs))
	for _, sub := range subs {
		if !sub.Wants(evt.Type) {
			continue
		}
		id, err := randomHex(16)
		if err != nil {
			return fmt.Errorf("генерация id доставки: %w", err)
		}
		batch = append(batch, domain.Delivery{
			ID:             "whdl_" + id,
			SubscriptionID: sub.ID,
			EventID:        evt.ID,
			EventType:      evt.Type,
			Payload:        evt.Payload,
			Status:         domain.StatusQueued,
			NextAttemptAt:  now,
			CreatedAt:      now,
		})
	}
	if len(batch) == 0 {
		return nil // события некому везти — нормальная тишина
	}
	if err := p.deliveries.Enqueue(ctx, batch); err != nil {
		return err
	}
	logging.Infof(ctx, "событие %s (%s): поставлено доставок — %d", shortID(evt.ID), evt.Type, len(batch))
	return nil
}

// Tick — фоновый такт: взять настоевшие, доставить, зафиксировать.
// Ошибок наружу не бросает (вызывает тикер в main) — логирует:
// сбой одной доставки не останавливает остальных, неотмеченная
// попытка просто повторится следующим тиком.
func (p *Postman) Tick(ctx context.Context) {
	due, err := p.deliveries.Due(ctx, p.now(), p.batch)
	if err != nil {
		logging.Errorf(ctx, "tick: чтение настоевших доставок: %v", err)
		return
	}
	for _, d := range due {
		p.attempt(ctx, d)
	}
}

// attempt — одна доставка: конверт → партнёру → вердикт. 2xx —
// delivered; иначе попытка растёт, пауза удваивается, после
// maxAttempts — dead (DLQ витрины).
func (p *Postman) attempt(ctx context.Context, d domain.Delivery) {
	sub, err := p.subs.Get(ctx, d.SubscriptionID)
	if err != nil {
		// подписку снесли, а доставка стояла: гасим тихо — везти некому
		if errors.Is(err, domain.ErrSubscriptionNotFound) {
			d.Status = domain.StatusDead
			d.LastError = "подписка удалена"
			d.Attempts++
			_ = p.deliveries.Save(ctx, d)
			if p.observer != nil {
				p.observer.Dead()
			}
			return
		}
		logging.Errorf(ctx, "tick: чтение подписки %s: %v", d.SubscriptionID, err)
		return
	}

	now := p.now()
	env := domain.Envelope{
		DeliveryID:     d.ID,
		SubscriptionID: d.SubscriptionID,
		Type:           d.EventType,
		OccurredAt:     d.CreatedAt.UTC().Format(time.RFC3339Nano),
		Data:           json.RawMessage(d.Payload),
	}
	sendErr := p.sender.Send(ctx, sub, env)
	d.Attempts++

	if sendErr == nil {
		d.Status = domain.StatusDelivered
		d.DeliveredAt = &now
		d.LastError = ""
		if err := p.deliveries.Save(ctx, d); err != nil {
			logging.Warnf(ctx, "tick: отметка доставленной %s: %v (следующий тик повторит партнёру)", d.ID, err)
			return
		}
		if p.observer != nil {
			p.observer.Delivered(d.EventType)
		}
		logging.Infof(ctx, "доставка %s → %s (%s) с %d-й попытки", d.ID, sub.URL, d.EventType, d.Attempts)
		return
	}

	d.LastError = sendErr.Error()
	if p.observer != nil {
		p.observer.Failed(d.EventType)
	}
	if d.Attempts >= p.maxAttempts {
		d.Status = domain.StatusDead
		d.NextAttemptAt = time.Time{} // DLQ — расписания нет
		if err := p.deliveries.Save(ctx, d); err != nil {
			logging.Warnf(ctx, "tick: проводка в DLQ %s: %v", d.ID, err)
			return
		}
		if p.observer != nil {
			p.observer.Dead()
		}
		logging.Warnf(ctx, "доставка %s → %s умерла после %d попыток: %s (перепосылка — в витрине)",
			d.ID, sub.URL, d.Attempts, d.LastError)
		return
	}
	d.Status = domain.StatusQueued
	d.NextAttemptAt = now.Add(p.backoff(d.Attempts))
	if err := p.deliveries.Save(ctx, d); err != nil {
		logging.Warnf(ctx, "tick: расписание ретрая %s: %v (следующий тик повторит)", d.ID, err)
		return
	}
	logging.Warnf(ctx, "доставка %s → %s не вышла (попытка %d/%d): %s; следующая %s",
		d.ID, sub.URL, d.Attempts, p.maxAttempts, d.LastError, d.NextAttemptAt.Format("15:04:05"))
}

// Deliveries — витрина доставок с фильтрами.
func (p *Postman) Deliveries(ctx context.Context, f domain.DeliveryFilter) ([]domain.Delivery, error) {
	return p.deliveries.List(ctx, f)
}

// Counts — итоги по статусам для шапки витрины.
func (p *Postman) Counts(ctx context.Context) (map[domain.DeliveryStatus]int, error) {
	return p.deliveries.Counts(ctx)
}

// Replay — перепослать из витрины: delivered/dead возвращается
// в очередь с чистым счётчиком попыток (решение человека сильнее
// расписания). Очередную queued перепосылать не даём (409 витрины).
func (p *Postman) Replay(ctx context.Context, id string) (domain.Delivery, error) {
	d, err := p.deliveries.Replay(ctx, id, p.now())
	if err != nil {
		return domain.Delivery{}, err
	}
	if p.observer != nil {
		p.observer.Replayed()
	}
	logging.Infof(ctx, "доставка %s возвращена в очередь из витрины (была %s, попытки с нуля)", d.ID, d.Status)
	return d, nil
}

// randomHex — n криптостойких случайных байт hex-строкой (2n символов).
func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// eventsLabel — фильтр для лога: пустой = все события.
func eventsLabel(events []string) string {
	if len(events) == 0 {
		return "все"
	}
	return strings.Join(events, ", ")
}

// shortID — отпечаток события для лога: полный sha256 нечитаем.
func shortID(id string) string {
	if len(id) > 12 {
		return id[:12] + "…"
	}
	return id
}

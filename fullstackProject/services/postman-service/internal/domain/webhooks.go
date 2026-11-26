// Package domain — сердце «Почтальона»: подписки партнёров на события
// брони и их доставки. Событие (at-least-once из обменa «cinema»)
// разворачивается в доставки по подходящим подпискам; тикер везёт
// настоевшие партнёрам с HMAC-подписью, пока не выйдет или не умрёт
// в DLQ. Хранилища, брокер и HTTP — заменяемые адаптеры снаружи.
package domain

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ErrInvalidSubscription — партнёрская подписка доменно невалидна
// (пустой URL, неизвестный тип события): витрина отвечает 400.
var ErrInvalidSubscription = errors.New("битая подписка партнёра")

// ErrSubscriptionNotFound — подписки нет (уже удалена).
var ErrSubscriptionNotFound = errors.New("подписка не найдена")

// ErrDeliveryNotFound — доставки нет в витрине.
var ErrDeliveryNotFound = errors.New("доставка не найдена")

// ErrNotReplayable — перепосылка имеет смысл только для доставленных
// и мёртвых: queued и так едет сам (409 витрины).
var ErrNotReplayable = errors.New("доставка уже в очереди — перепосылка не нужна")

// ErrInvalidEvent — событие брокера доменно невалидно (битый JSON):
// ретраи бессмысленны, консьюмер везёт его сразу в parking.
var ErrInvalidEvent = errors.New("битое событие брони")

// EventTypes — события жизненного цикла брони, которые Почтальон
// принимает из обменa «cinema» и умеет доставлять партнёрам.
// Бронь оплачена и создана (booking.created), вердикт платёжной саги
// (booking.processed), резерв истёк без оплаты (booking.expired),
// возврат по отмене (booking.refunded). Внутренние события (кэшбэк,
// рекомендации, бар, письма) партнёрам не предлагаются.
var EventTypes = []string{
	"booking.created",
	"booking.processed",
	"booking.expired",
	"booking.refunded",
}

// IsValidEventType — фильтр подписки и консьюмера.
func IsValidEventType(t string) bool {
	for _, known := range EventTypes {
		if t == known {
			return true
		}
	}
	return false
}

// DeliveryStatus — жизненный цикл доставки: queued ждёт своей
// попытки (первой или очередной), delivered — доставлена (2xx),
// dead — DLQ: попытки кончились, ждёт решения человека в витрине.
type DeliveryStatus string

const (
	StatusQueued    DeliveryStatus = "queued"
	StatusDelivered DeliveryStatus = "delivered"
	StatusDead      DeliveryStatus = "dead"
)

// Event — событие брони, принятое из брокера. ID — отпечаток
// (routing key + тело): консьюмер считает его sha256, дедупликация
// deliveries сидит на паре (подписка, ID) — ределивери брокера
// не плодит повторные доставки партнёру.
type Event struct {
	ID         string
	Type       string
	Payload    []byte
	ReceivedAt time.Time
}

// Subscription — подписка партнёра: куда доставлять (URL), чем
// подписывать (Secret, генерируется при создании и показывается
// один раз) и фильтр типов (пусто = все события EventTypes).
type Subscription struct {
	ID        string
	URL       string
	Secret    string
	Events    []string
	Active    bool
	CreatedAt time.Time
}

// Wants — подходит ли событие подписке: активна и тип в фильтре
// (пустой фильтр — все события брони).
func (s Subscription) Wants(eventType string) bool {
	if !s.Active {
		return false
	}
	if len(s.Events) == 0 {
		return true
	}
	for _, e := range s.Events {
		if e == eventType {
			return true
		}
	}
	return false
}

// Delivery — доставка одного события одному партнёру. Попытки и
// расписание ведёт Почтальон: NextAttemptAt — когда тикер возьмёт
// снова, LastError — что ответил партнёр (или сеть), Attempts —
// сколько раз уже пробовали.
type Delivery struct {
	ID             string
	SubscriptionID string
	EventID        string
	EventType      string
	Payload        []byte
	Status         DeliveryStatus
	Attempts       int
	NextAttemptAt  time.Time
	LastError      string
	CreatedAt      time.Time
	DeliveredAt    *time.Time
}

// Envelope — конверт вебхука: то, что летит партнёру в теле POST.
// Data — событие как опубликовано в обмене, без переложения полей:
// партнёр видит шину честно. DeliveryID позволяет партнёру
// идемпотентно гасить повторы (at-least-once).
type Envelope struct {
	DeliveryID     string          `json:"deliveryId"`
	SubscriptionID string          `json:"subscriptionId"`
	Type           string          `json:"type"`
	OccurredAt     string          `json:"occurredAt"`
	Data           json.RawMessage `json:"data"`
}

// SubscriptionsStore — порт хранилища подписок (память или Postgres).
type SubscriptionsStore interface {
	// Add сохраняет новую подписку (ID уже присвоен use-case'ом).
	Add(ctx context.Context, s Subscription) error
	// Get — подписка по id (ErrSubscriptionNotFound, если нет).
	Get(ctx context.Context, id string) (Subscription, error)
	// Delete — убрать подписку; false, если её уже не было.
	Delete(ctx context.Context, id string) (bool, error)
	// List — все подписки витрины, свежие сверху.
	List(ctx context.Context) ([]Subscription, error)
}

// DeliveriesStore — порт хранилища доставок. Идемпотентность —
// атрибут адаптера: Enqueue молча пропускает пару (подписка, событие),
// которая уже стоит в очереди или доставлена.
type DeliveriesStore interface {
	// Enqueue — поставить доставки (батч fan-out одного события).
	Enqueue(ctx context.Context, batch []Delivery) error
	// Due — настоевшие к моменту now, старыми первыми, не более limit.
	Due(ctx context.Context, now time.Time, limit int) ([]Delivery, error)
	// Save фиксирует прогресс доставки: статус, попытки, расписание,
	// последнюю ошибку, время доставки.
	Save(ctx context.Context, d Delivery) error
	// Get — доставка по id (ErrDeliveryNotFound, если нет).
	Get(ctx context.Context, id string) (Delivery, error)
	// Replay — delivered/dead обратно в очередь: попытки с нуля,
	// расписание «сейчас»; ErrNotReplayable для queued, ErrDeliveryNotFound
	// если доставки нет. Возвращает обновлённую доставку.
	Replay(ctx context.Context, id string, now time.Time) (Delivery, error)
	// List — витрина доставок: фильтры необязательны, свежие сверху.
	List(ctx context.Context, f DeliveryFilter) ([]Delivery, error)
	// Counts — итоги по статусам для шапки витрины.
	Counts(ctx context.Context) (map[DeliveryStatus]int, error)
}

// DeliveryFilter — фильтры витрины доставок; пустые поля не фильтруют.
type DeliveryFilter struct {
	SubscriptionID string
	Status         DeliveryStatus
	Limit          int
}

// WebhookSender — исходящий порт: доставить конверт партнёру.
// Подпись HMAC и таймаут — забота адаптера; домену достаточно
// «доставлено / не доставлено».
type WebhookSender interface {
	Send(ctx context.Context, s Subscription, e Envelope) error
}

// DeliveryObserver — порт телеметрии исходов: домен сообщает факты,
// адаптер за портом (Prometheus в проде, nil в тестах) считает их.
type DeliveryObserver interface {
	Delivered(eventType string)
	Failed(eventType string)
	Dead()
	Replayed()
}

// NormalizeEvents — фильтр подписки: пустой список = все события
// (хранится как пустая строка), лишние пробелы и повторы убираются.
func NormalizeEvents(events []string) []string {
	seen := make(map[string]bool, len(events))
	out := make([]string, 0, len(events))
	for _, e := range events {
		e = strings.TrimSpace(e)
		if e == "" || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return out
}

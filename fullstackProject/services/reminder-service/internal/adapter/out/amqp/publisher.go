// Package amqp — исходящий адаптер: издатель «писем»-напоминаний
// в обмен cinema. В отличие от консьюмеров проекта retry-очередей нет:
// сбой публикации повторит следующий тик планировщика — запись
// остаётся SCHEDULED, пока письмо не ушло.
package amqp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/rabbitmq/amqp091-go"

	"reminder-service/internal/domain"
)

const (
	exchangeName = "cinema"
	// RoutingKey — ключ события напоминания; читают notification-service
	// (письмо) и NestJS API (SSE-баннер).
	RoutingKey = "user.session.reminder"
)

// letterPayload — JSON события напоминания (camelCase, как все
// контракты обмена). Message — готовый текст письма из домена.
type letterPayload struct {
	BookingID  string   `json:"bookingId"`
	UserID     string   `json:"userId"`
	Email      string   `json:"email"`
	MovieID    string   `json:"movieId"`
	MovieTitle string   `json:"movieTitle"`
	Hall       string   `json:"hall"`
	SessionAt  string   `json:"sessionAt"`
	Seats      []string `json:"seats"`
	RemindedAt string   `json:"remindedAt"`
	Message    string   `json:"message"`
}

// buildPayload собирает тело события; чистая функция — тестируется
// без брокера.
func buildPayload(r domain.Reminder) letterPayload {
	return letterPayload{
		BookingID:  r.BookingID,
		UserID:     r.UserID,
		Email:      r.Email,
		MovieID:    r.MovieID,
		MovieTitle: r.MovieTitle,
		Hall:       r.Hall,
		SessionAt:  r.SessionAt.Format(time.RFC3339),
		Seats:      r.Seats,
		RemindedAt: r.RemindedAt.Format(time.RFC3339),
		Message:    r.LetterText(),
	}
}

// Publisher держит одно соединение с брокером; канал спрятан за
// мьютексом, чтобы тикер публиковал concurrently с реконнектами.
type Publisher struct {
	url     string
	mu      sync.Mutex
	conn    *amqp091.Connection
	channel *amqp091.Channel
}

func NewPublisher(url string) *Publisher {
	return &Publisher{url: url}
}

// Run держит соединение до отмены контекста; реконнект с бэкоффом —
// обязанность main (как у консьюмеров соседних сервисов). Обмен
// объявляется симметрично остальным сторонам: кто стартует первым,
// тот и создаёт.
func (p *Publisher) Run(ctx context.Context) error {
	conn, err := amqp091.Dial(p.url)
	if err != nil {
		return fmt.Errorf("подключение к RabbitMQ: %w", err)
	}
	// повторный Close уже закрытого соединения безвреден (ветка notifyClose)
	defer func() { _ = conn.Close() }()

	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("канал RabbitMQ: %w", err)
	}
	if err := ch.ExchangeDeclare(exchangeName, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("объявление обмена %s: %w", exchangeName, err)
	}

	p.mu.Lock()
	p.conn = conn
	p.channel = ch
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.channel = nil
		p.conn = nil
		p.mu.Unlock()
	}()

	notifyClose := conn.NotifyClose(make(chan *amqp091.Error, 1))
	select {
	case <-ctx.Done():
		_ = ch.Close()
		return nil // штатная остановка — не повод для реконнекта
	case err, ok := <-notifyClose:
		if ok && err != nil {
			return fmt.Errorf("соединение закрыто брокером: %w", err)
		}
		return errors.New("соединение с брокером закрыто")
	}
}

// Publish — событие напоминания в обмен cinema. Persistent: сообщение
// переживает рестарт брокера в устойчивых очередях консьюмеров.
func (p *Publisher) Publish(ctx context.Context, r domain.Reminder) error {
	body, err := json.Marshal(buildPayload(r))
	if err != nil {
		return fmt.Errorf("сборка payload напоминания %s: %w", r.BookingID, err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.channel == nil {
		return errors.New("соединение с брокером не установлено")
	}
	return p.channel.PublishWithContext(ctx, exchangeName, RoutingKey, false, false, amqp091.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp091.Persistent,
		Timestamp:    r.RemindedAt,
		Body:         body,
	})
}

var _ domain.ReminderPublisher = (*Publisher)(nil)

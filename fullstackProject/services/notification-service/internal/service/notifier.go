// Package service — use-cases notification-service. Зависит только от
// домена и его портов; адаптеры сюда не импортируются никогда.
package service

import (
	"context"
	"fmt"
	"log"
	"time"

	"notification-service/internal/domain"
)

// Notifier — сценарий «получили вердикт → уведомили клиента → сохранили».
type Notifier struct {
	sender  domain.Sender
	repo    domain.Repository
	metrics domain.Metrics
	now     func() time.Time // инъекция часов — детерминизм в тестах
}

// NewNotifier собирает сценарий из портов. Все зависимости приходят
// снаружи — composition root в main решает, какие адаптеры стоят за ними.
func NewNotifier(sender domain.Sender, repo domain.Repository, metrics domain.Metrics) *Notifier {
	return &Notifier{sender: sender, repo: repo, metrics: metrics, now: time.Now}
}

// HandleOutcome — основной сценарий. Возвращает ошибку, если событие
// ядовитое (неизвестный вердикт) или сломалось собственное хранилище;
// сбой доставки письмом не считается — он фиксируется в статусе.
func (s *Notifier) HandleOutcome(ctx context.Context, o domain.Outcome) error {
	s.metrics.Received()

	n, err := domain.NewFromOutcome(o, s.now())
	if err != nil {
		s.metrics.Errors()
		return err // адаптер очереди уведёт сообщение в parking
	}

	if err := s.sender.Send(ctx, n); err != nil {
		n.Status = domain.StatusFailed
		n.Error = err.Error()
		s.metrics.Failed()
		log.Printf("✉ ! %s: доставка не удалась: %v", n.BookingID, err)
	} else {
		s.metrics.Sent(n.Kind)
	}

	if err := s.repo.Save(ctx, n); err != nil {
		s.metrics.Errors()
		return fmt.Errorf("сохранение уведомления %s: %w", n.BookingID, err)
	}

	if n.Status == domain.StatusSent {
		log.Printf("✉ %s [%s] «%s»", n.BookingID, n.Kind, n.Title)
	}
	return nil
}

// List — история уведомлений для HTTP-адаптера: новые сверху.
func (s *Notifier) List(ctx context.Context, f domain.Filter) ([]domain.Notification, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 50
	}
	return s.repo.List(ctx, f)
}

// Snapshot — метрики сервиса для /stats.
func (s *Notifier) Snapshot() map[string]any { return s.metrics.Snapshot() }

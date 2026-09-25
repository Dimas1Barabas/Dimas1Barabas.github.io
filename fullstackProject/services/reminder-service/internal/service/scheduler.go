// Package service — use-case'ы напоминаний: планирование по gRPC
// и фоновая отправка тикером.
package service

import (
	"context"
	"log"
	"time"

	"reminder-service/internal/domain"
)

// Scheduler — use-case напоминаний: планирует по запросу API
// и рассылает наступившие по тику.
type Scheduler struct {
	store domain.ReminderStore
	pub   domain.ReminderPublisher
	lead  time.Duration // за сколько до сеанса напоминать
	now   func() time.Time
}

func NewScheduler(store domain.ReminderStore, pub domain.ReminderPublisher, lead time.Duration) *Scheduler {
	return &Scheduler{store: store, pub: pub, lead: lead, now: time.Now}
}

// Schedule — проверить и запланировать. Прошедший сеанс — честный
// отказ (ErrSessionPassed): API фильтрует заранее, сюда попадает
// только гонка «сеанс начался между вердиктом и вызовом».
func (s *Scheduler) Schedule(ctx context.Context, r domain.Reminder) (domain.ScheduleResult, error) {
	if err := r.Validate(); err != nil {
		return domain.ScheduleResult{}, err
	}
	now := s.now()
	if !r.SessionAt.After(now) {
		return domain.ScheduleResult{}, domain.ErrSessionPassed
	}
	r.Status = domain.StatusScheduled
	r.DueAt = domain.ComputeDue(r.SessionAt, s.lead, now)
	if err := s.store.Schedule(ctx, r); err != nil {
		return domain.ScheduleResult{}, err
	}
	return domain.ScheduleResult{Status: string(domain.StatusScheduled), DueAt: r.DueAt}, nil
}

// Cancel — возврат билетов гасит напоминание. Отсутствующее — не
// ошибка: идемпотентность ределивери саги возврата.
func (s *Scheduler) Cancel(ctx context.Context, bookingID string) (string, error) {
	if bookingID == "" {
		return "", domain.ErrEmptyBookingID
	}
	found, err := s.store.Cancel(ctx, bookingID)
	if err != nil {
		return "", err
	}
	if !found {
		return "MISSING", nil
	}
	return string(domain.StatusCancelled), nil
}

// Tick — фоновый такт: найти наступившие, опубликовать, пометить.
// Ошибок наружу не бросает (вызывает тикер в main) — логирует:
// сбой публикации оставит запись SCHEDULED, следующий тик повторит,
// письмо без отметки SENT не потеряется.
func (s *Scheduler) Tick(ctx context.Context) {
	due, err := s.store.Due(ctx, s.now())
	if err != nil {
		log.Printf("tick: чтение наступивших напоминаний: %v", err)
		return
	}
	for _, r := range due {
		now := s.now()
		r.RemindedAt = now
		if err := s.pub.Publish(ctx, r); err != nil {
			log.Printf("tick: публикация напоминания %s: %v (следующий тик повторит)", r.BookingID, err)
			continue
		}
		if err := s.store.MarkSent(ctx, r.BookingID, now); err != nil {
			log.Printf("tick: отметка отправленным %s: %v", r.BookingID, err)
		}
	}
}

// List — витрина напоминаний (HTTP-стенд).
func (s *Scheduler) List(ctx context.Context) ([]domain.Reminder, error) {
	return s.store.List(ctx)
}

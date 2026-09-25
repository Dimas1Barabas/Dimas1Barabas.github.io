package domain

import (
	"context"
	"time"
)

// ReminderStore — порт хранилища напоминаний (память или Postgres).
type ReminderStore interface {
	// Schedule сохраняет напоминание; дубль по BookingID — no-op
	// (ределивери вердикта воркера не плодит записи).
	Schedule(ctx context.Context, r Reminder) error
	// Cancel гасит SCHEDULED-напоминание брони; false — не было
	// или уже не SCHEDULED (письмо ушло / погашено ранее).
	Cancel(ctx context.Context, bookingID string) (bool, error)
	// Due возвращает SCHEDULED-напоминания, чей момент наступил.
	Due(ctx context.Context, now time.Time) ([]Reminder, error)
	// MarkSent помечает отправленным; условие status='SCHEDULED'
	// страхует от второй отправки той же записи.
	MarkSent(ctx context.Context, bookingID string, at time.Time) error
	// List — витрина стенда: все напоминания свежими сверху.
	List(ctx context.Context) ([]Reminder, error)
}

// ReminderPublisher — порт доставки: «письмо» уходит событием
// в обмен cinema, читают его notification-service (письмо)
// и NestJS API (SSE-баннер зрителю).
type ReminderPublisher interface {
	Publish(ctx context.Context, r Reminder) error
}

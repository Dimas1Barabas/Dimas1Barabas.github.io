package domain

import "context"

// Порты гексагона: use-case зависит от этих интерфейсов, адаптеры их
// реализуют. Меняем «email в консоли» на SMTP или добавляем persist
// в Postgres — домен и сценарии не меняются ни строкой.

// Sender — исходящий канал доставки (driven). Реализация решает, куда
// реально уходит письмо: консоль демо-стенда, SMTP, push.
type Sender interface {
	Send(ctx context.Context, n Notification) error
}

// Filter — параметры выборки истории уведомлений.
type Filter struct {
	BookingID string // пусто — все брони
	Limit     int    // <= 0 — дефолт адаптера
}

// Repository — хранение отправленных уведомлений (driven).
type Repository interface {
	// Exists — записано ли письмо с таким ID (дедуп ределивери до
	// отправки). Осмыслен только для идемпотентных ID (messageId).
	Exists(ctx context.Context, id string) (bool, error)
	// Save записывает письмо; false — запись с таким ID уже была
	// (ределивери), вторая строка не создаётся.
	Save(ctx context.Context, n Notification) (created bool, err error)
	List(ctx context.Context, f Filter) ([]Notification, error)
}

// Metrics — счётчики для /stats (driven, сквозная забота).
type Metrics interface {
	Received()      // событие пришло из очереди
	Sent(kind Kind) // письмо ушло
	Failed()        // шлюз доставки упал
	Errors()        // собственный сбой сервиса
	Replayed()      // дубль ределивери погашен по идемпотентному ID
	Snapshot() map[string]any
}

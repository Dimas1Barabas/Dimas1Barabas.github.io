package domain

import "context"

// AnalyticsStore — порт хранилища Аналитика (память или Postgres):
// инкрементные агрегаты, витрина читает их целиком. События —
// at-least-once; идемпотентность не требуется: аналитика терпит
// редкий дубль клика, зато не теряет ничего.
type AnalyticsStore interface {
	// ApplyWebEvent раскладывает событие поведения по агрегатам:
	// воронка, интерес к фильму, страницы, места, время в модалке.
	ApplyWebEvent(ctx context.Context, e Event) error
	// ApplyBookingPaid — брокерское booking.created: воронка paid +
	// бронирование фильма (знаменатель конверсии).
	ApplyBookingPaid(ctx context.Context, bookingID, movieID string) error
	// ApplyBookingVerdict — брокерское booking.processed:
	// воронка confirmed или failed.
	ApplyBookingVerdict(ctx context.Context, bookingID string, confirmed bool) error
	// Insights — витрина «Поведение» одним ответом.
	Insights(ctx context.Context) (Insights, error)
}

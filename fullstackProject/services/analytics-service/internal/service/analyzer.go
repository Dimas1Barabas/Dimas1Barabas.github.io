// Package service — use-case'ы Аналитика: события поведения и брокера
// сводятся в агрегаты хранилища, витрина читает их целиком. Оркестрация
// без знания о транспортах и хранилище.
package service

import (
	"context"
	"fmt"

	"analytics-service/internal/domain"
)

// Analyzer применяет события к агрегатам и отвечает витриной.
type Analyzer struct {
	store domain.AnalyticsStore
}

// NewAnalyzer собирает анализатор над хранилищем.
func NewAnalyzer(store domain.AnalyticsStore) *Analyzer {
	return &Analyzer{store: store}
}

// HandleWebEvent валидирует событие поведения и раскладывает по
// агрегатам. Битное (нет aid, неизвестен тип, отрицательное время,
// битный код места) — ErrInvalidEvent: ретраи не изменят ответ.
func (a *Analyzer) HandleWebEvent(ctx context.Context, e domain.Event) error {
	if e.AID == "" {
		return fmt.Errorf("%w: событие без aid", domain.ErrInvalidEvent)
	}
	switch e.Type {
	case domain.EventPageView:
		if e.Route == "" {
			return fmt.Errorf("%w: page_view без маршрута", domain.ErrInvalidEvent)
		}
	case domain.EventPageDwell:
		if e.Route == "" || e.MS < 0 {
			return fmt.Errorf("%w: page_dwell без маршрута или с отрицательным временем", domain.ErrInvalidEvent)
		}
	case domain.EventBookingModalOpen:
		if e.MovieID == "" {
			return fmt.Errorf("%w: booking_modal_open без фильма", domain.ErrInvalidEvent)
		}
	case domain.EventSessionSelected:
		if e.MovieID == "" || e.SessionID == "" {
			return fmt.Errorf("%w: session_selected без фильма/сеанса", domain.ErrInvalidEvent)
		}
	case domain.EventSeatsSelected:
		if e.SessionID == "" || e.Count < 1 {
			return fmt.Errorf("%w: seats_selected без сеанса или мест", domain.ErrInvalidEvent)
		}
	case domain.EventSeatClick:
		if e.SessionID == "" || e.Seat == "" || e.Hall == "" {
			return fmt.Errorf("%w: seat_click без сеанса/места/зала", domain.ErrInvalidEvent)
		}
	case domain.EventBookingCreated:
		if e.BookingID == "" {
			return fmt.Errorf("%w: booking_created без брони", domain.ErrInvalidEvent)
		}
	case domain.EventPaymentOpened:
		if e.BookingID == "" {
			return fmt.Errorf("%w: payment_opened без брони", domain.ErrInvalidEvent)
		}
	case domain.EventModalDwell:
		if e.MovieID == "" || e.MS < 0 {
			return fmt.Errorf("%w: modal_dwell без фильма или с отрицательным временем", domain.ErrInvalidEvent)
		}
		switch e.Deepest {
		case "session", "seats", "created":
		default:
			return fmt.Errorf("%w: modal_dwell с неизвестной глубиной %q", domain.ErrInvalidEvent, e.Deepest)
		}
	default:
		return fmt.Errorf("%w: неизвестный тип %q", domain.ErrInvalidEvent, e.Type)
	}

	if err := a.store.ApplyWebEvent(ctx, e); err != nil {
		return fmt.Errorf("событие %s: %w", e.Type, err)
	}
	return nil
}

// HandleBookingPaid — брокерское booking.created (бронь оплачена):
// шаг воронки paid + бронирование фильма для конверсии.
func (a *Analyzer) HandleBookingPaid(ctx context.Context, bookingID, movieID string) error {
	if bookingID == "" || movieID == "" {
		return fmt.Errorf("%w: booking.created без bookingId/movieId", domain.ErrInvalidEvent)
	}
	if err := a.store.ApplyBookingPaid(ctx, bookingID, movieID); err != nil {
		return fmt.Errorf("paid %s: %w", bookingID, err)
	}
	return nil
}

// HandleBookingVerdict — брокерское booking.processed: вердикт воркера
// закрывает воронку (confirmed) или фиксирует отказ (failed).
func (a *Analyzer) HandleBookingVerdict(ctx context.Context, bookingID string, confirmed bool) error {
	if bookingID == "" {
		return fmt.Errorf("%w: booking.processed без bookingId", domain.ErrInvalidEvent)
	}
	if err := a.store.ApplyBookingVerdict(ctx, bookingID, confirmed); err != nil {
		return fmt.Errorf("verdict %s: %w", bookingID, err)
	}
	return nil
}

// Insights — витрина «Поведение».
func (a *Analyzer) Insights(ctx context.Context) (domain.Insights, error) {
	return a.store.Insights(ctx)
}

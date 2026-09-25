package domain

import (
	"errors"
	"testing"
	"time"
)

// Фабрика уведомлений: каждый вердикт получает свой тип и заголовок,
// неизвестный вердикт — ядовитое событие.
func TestNewFromOutcome(t *testing.T) {
	now := time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		verdict   string
		wantKind  Kind
		wantTitle string
	}{
		{"CONFIRMED", KindConfirmed, "Бронь подтверждена"},
		{"FAILED", KindFailed, "Платёж не прошёл"},
		{"CANCELLED", KindRefunded, "Возврат зачислен"},
		{"REFUND_FAILED", KindRefundFailed, "Возврат не удался"},
		{"EXPIRED", KindExpired, "Время оплаты истекло"},
		{"PASSWORD_RESET", KindPasswordReset, "Сброс пароля"},
		{"WAITLIST_SEAT", KindWaitlistSeat, "Место освободилось"},
		{"SESSION_REMINDER", KindSessionReminder, "Скоро сеанс"},
	}
	for _, tc := range cases {
		t.Run(tc.verdict, func(t *testing.T) {
			n, err := NewFromOutcome(Outcome{
				BookingID: "b-1", Verdict: tc.verdict, Message: "текст от воркера",
			}, now)
			if err != nil {
				t.Fatalf("неожданная ошибка: %v", err)
			}
			if n.Kind != tc.wantKind {
				t.Fatalf("kind = %q, want %q", n.Kind, tc.wantKind)
			}
			if n.Title != tc.wantTitle {
				t.Fatalf("title = %q, want %q", n.Title, tc.wantTitle)
			}
			if n.Body != "текст от воркера" {
				t.Fatalf("body = %q, want текст от воркера", n.Body)
			}
			if n.Status != StatusSent {
				t.Fatalf("статус по умолчанию = %q, want SENT", n.Status)
			}
			if n.Channel != "email" {
				t.Fatalf("channel = %q, want email", n.Channel)
			}
			if n.ID == "" {
				t.Fatal("id пуст")
			}
		})
	}

	t.Run("неизвестный вердикт", func(t *testing.T) {
		_, err := NewFromOutcome(Outcome{BookingID: "b-1", Verdict: "WAT"}, now)
		if !errors.Is(err, ErrUnknownVerdict) {
			t.Fatalf("ошибка = %v, want ErrUnknownVerdict", err)
		}
	})
}

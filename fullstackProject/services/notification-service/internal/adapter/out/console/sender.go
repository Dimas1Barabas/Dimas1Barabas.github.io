// Package console — Sender-адаптер: «отправляет email» в stdout.
// В стенде этого достаточно; замена на SMTP не тронет ни домен,
// ни use-case — это вся смена адаптера.
package console

import (
	"context"
	"log"
	"os"

	"notification-service/internal/domain"
)

// Sender печатает письмо в отдельный логгер без префиксов времени,
// чтобы блок читался как письмо, а не как строка журнала.
type Sender struct {
	logger *log.Logger
}

// NewSender — консольный «почтовый шлюз». Ошибки имитировать не нужно:
// сбой доставки моделируется в тестах стабом порта.
func NewSender() *Sender {
	return &Sender{logger: log.New(os.Stdout, "", 0)}
}

func (s *Sender) Send(_ context.Context, n domain.Notification) error {
	to := pseudoEmail(n.BookingID)
	ref := "бронь " + n.BookingID
	switch n.Kind {
	case domain.KindPasswordReset:
		// в сбросе пароля адресат — настоящий email из события (в BookingID)
		to = n.BookingID
		ref = "сброс пароля"
	case domain.KindWaitlistSeat:
		// в листе ожидания адресат тоже настоящий email (в BookingID)
		to = n.BookingID
		ref = "лист ожидания"
	case domain.KindSessionReminder:
		// напоминание о сеансе шлётся на email зрителя (в BookingID)
		to = n.BookingID
		ref = "напоминание о сеансе"
	}
	s.logger.Printf("╭─ ✉ email → %s\n│ тема: %s\n│ тело: %s\n╰─ %s · %s",
		to, n.Title, n.Body, ref, n.CreatedAt.Format("15:04:05"))
	return nil
}

// pseudoEmail — демонстрационный адрес: настоящие события не таскают
// e-mail клиента, и выдумывать его в домене было бы ложью.
func pseudoEmail(bookingID string) string {
	return "customer+" + bookingID + "@cinebooking.local"
}

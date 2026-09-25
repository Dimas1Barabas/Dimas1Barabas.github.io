package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// Status — жизненный цикл напоминания.
type Status string

const (
	// StatusScheduled — ждёт своего момента (сеанс − окно).
	StatusScheduled Status = "SCHEDULED"
	// StatusSent — письмо ушло в брокер.
	StatusSent Status = "SENT"
	// StatusCancelled — бронь возвращена, напоминание погашено.
	StatusCancelled Status = "CANCELLED"
)

// Reminder — запланированное напоминание о сеансе подтверждённой
// брони. Ключ идемпотентности — BookingID: повторный Schedule
// (ределивери вердикта воркера) не плодит записи.
type Reminder struct {
	BookingID  string
	UserID     string
	Email      string // адресат «письма»
	MovieID    string
	MovieTitle string
	Hall       string
	SessionAt  time.Time // момент сеанса
	Seats      []string  // коды мест брони, для текста письма
	DueAt      time.Time // момент отправки письма
	Status     Status
	RemindedAt time.Time // когда письмо ушло; zero = ещё не ушло
}

var (
	// ErrInvalidReminder — напоминание не проходит валидацию.
	ErrInvalidReminder = errors.New("некорректное напоминание")
	// ErrSessionPassed — сеанс уже прошёл, напоминать поздно.
	ErrSessionPassed = errors.New("сеанс уже прошёл")
	// ErrEmptyBookingID — отмена без идентификатора брони.
	ErrEmptyBookingID = errors.New("пустой идентификатор брони")
)

// Validate — структурная проверка перед записью в хранилище.
// Момент сеанса проверяет Scheduler: ему нужно «сейчас».
func (r Reminder) Validate() error {
	if r.BookingID == "" || r.UserID == "" || r.Email == "" ||
		r.MovieTitle == "" || r.Hall == "" || len(r.Seats) == 0 {
		return ErrInvalidReminder
	}
	return nil
}

// ComputeDue — момент отправки: за lead до сеанса. Если окно уже
// упущено (бронь подтвердили позже), письмо уходит «на сейчас» —
// следующий тик его подхватит: поздно лучше, чем никогда.
func ComputeDue(sessionAt time.Time, lead time.Duration, now time.Time) time.Time {
	due := sessionAt.Add(-lead)
	if due.Before(now) {
		return now
	}
	return due
}

// LetterText — текст «письма»-напоминания. Формулировка живёт
// в домене, а не в транспорте: она часть фичи (прецедент —
// заголовки писем notification-service).
func (r Reminder) LetterText() string {
	return fmt.Sprintf("Скоро сеанс: «%s» (%s, %s), ваши места %s. Билеты — по QR-ссылке.",
		r.MovieTitle, r.Hall, r.SessionAt.Format("02.01 15:04"), strings.Join(r.Seats, ", "))
}

// ScheduleResult — ответ планирования для gRPC-адаптера.
type ScheduleResult struct {
	Status string
	DueAt  time.Time
}

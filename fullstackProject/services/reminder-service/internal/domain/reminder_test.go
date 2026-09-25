package domain

import (
	"strings"
	"testing"
	"time"
)

func validReminder() Reminder {
	return Reminder{
		BookingID:  "b-1",
		UserID:     "u-1",
		Email:      "u@cine.local",
		MovieID:    "m-1",
		MovieTitle: "Дюна",
		Hall:       "Красный",
		SessionAt:  time.Date(2026, 9, 25, 19, 0, 0, 0, time.UTC),
		Seats:      []string{"5-7", "5-8"},
	}
}

func TestValidate(t *testing.T) {
	if err := validReminder().Validate(); err != nil {
		t.Fatalf("валидное напоминание отклонено: %v", err)
	}
	cases := map[string]func(*Reminder){
		"нет брони":   func(r *Reminder) { r.BookingID = "" },
		"нет зрителя": func(r *Reminder) { r.UserID = "" },
		"нет email":   func(r *Reminder) { r.Email = "" },
		"нет фильма":  func(r *Reminder) { r.MovieTitle = "" },
		"нет зала":    func(r *Reminder) { r.Hall = "" },
		"нет мест":    func(r *Reminder) { r.Seats = nil },
	}
	for name, mutate := range cases {
		r := validReminder()
		mutate(&r)
		if err := r.Validate(); err == nil {
			t.Errorf("%s: Validate прошёл, want отказ", name)
		}
	}
}

func TestComputeDue(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	lead := 2 * time.Hour

	// обычный случай: сеанс в 19:00 → письмо в 17:00
	got := ComputeDue(time.Date(2026, 9, 25, 19, 0, 0, 0, time.UTC), lead, now)
	if want := time.Date(2026, 9, 25, 17, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("due = %v, want %v", got, want)
	}

	// окно упущено: до сеанса меньше lead — уходит «на сейчас»,
	// следующий тик подхватит
	got = ComputeDue(now.Add(30*time.Minute), lead, now)
	if !got.Equal(now) {
		t.Fatalf("due при упущенном окне = %v, want %v", got, now)
	}
}

func TestLetterText(t *testing.T) {
	text := validReminder().LetterText()
	for _, want := range []string{"Дюна", "Красный", "25.09 19:00", "5-7, 5-8"} {
		if !strings.Contains(text, want) {
			t.Errorf("письмо %q без %q", text, want)
		}
	}
}

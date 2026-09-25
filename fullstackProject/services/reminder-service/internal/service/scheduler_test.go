package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"reminder-service/internal/domain"
)

var fixedNow = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

// stubStore — стаб порта хранилища: Due отдаёт заготовку теста.
type stubStore struct {
	due         []domain.Reminder
	dueErr      error
	cancelFound bool
	scheduled   []domain.Reminder
	cancelled   []string
	markSent    []string
}

func (s *stubStore) Schedule(_ context.Context, r domain.Reminder) error {
	s.scheduled = append(s.scheduled, r)
	return nil
}

func (s *stubStore) Cancel(_ context.Context, bookingID string) (bool, error) {
	s.cancelled = append(s.cancelled, bookingID)
	return s.cancelFound, nil
}

func (s *stubStore) Due(_ context.Context, _ time.Time) ([]domain.Reminder, error) {
	return s.due, s.dueErr
}

func (s *stubStore) MarkSent(_ context.Context, bookingID string, _ time.Time) error {
	s.markSent = append(s.markSent, bookingID)
	return nil
}

func (s *stubStore) List(_ context.Context) ([]domain.Reminder, error) { return nil, nil }

// stubPublisher — стаб порта доставки.
type stubPublisher struct {
	published []domain.Reminder
	err       error
}

func (p *stubPublisher) Publish(_ context.Context, r domain.Reminder) error {
	if p.err != nil {
		return p.err
	}
	p.published = append(p.published, r)
	return nil
}

func newScheduler(store domain.ReminderStore, pub domain.ReminderPublisher) *Scheduler {
	s := NewScheduler(store, pub, 2*time.Hour)
	s.now = func() time.Time { return fixedNow }
	return s
}

func validRequest() domain.Reminder {
	return domain.Reminder{
		BookingID: "b-1", UserID: "u-1", Email: "u@cine.local",
		MovieID: "m-1", MovieTitle: "Дюна", Hall: "Красный",
		SessionAt: fixedNow.Add(5 * time.Hour), // 17:00
		Seats:     []string{"5-7"},
	}
}

func TestSchedulePlansWindow(t *testing.T) {
	store, pub := &stubStore{}, &stubPublisher{}
	res, err := newScheduler(store, pub).Schedule(context.Background(), validRequest())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != string(domain.StatusScheduled) {
		t.Fatalf("status = %q, want SCHEDULED", res.Status)
	}
	// сеанс 17:00 − окно 2 часа → письмо в 15:00
	if want := fixedNow.Add(3 * time.Hour); !res.DueAt.Equal(want) {
		t.Fatalf("dueAt = %v, want %v", res.DueAt, want)
	}
	if len(store.scheduled) != 1 {
		t.Fatalf("запланировано %d, want 1", len(store.scheduled))
	}
	if store.scheduled[0].Status != domain.StatusScheduled {
		t.Fatalf("статус записи = %q, want SCHEDULED", store.scheduled[0].Status)
	}
}

func TestScheduleWindowMissedDueNow(t *testing.T) {
	store, pub := &stubStore{}, &stubPublisher{}
	r := validRequest()
	r.SessionAt = fixedNow.Add(30 * time.Minute) // меньше окна 2 часа
	res, err := newScheduler(store, pub).Schedule(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if !res.DueAt.Equal(fixedNow) {
		t.Fatalf("dueAt при упущенном окне = %v, want сейчас (%v)", res.DueAt, fixedNow)
	}
}

func TestScheduleRejectsPastSession(t *testing.T) {
	store, pub := &stubStore{}, &stubPublisher{}
	r := validRequest()
	r.SessionAt = fixedNow.Add(-time.Hour)
	if _, err := newScheduler(store, pub).Schedule(context.Background(), r); !errors.Is(err, domain.ErrSessionPassed) {
		t.Fatalf("ошибка = %v, want ErrSessionPassed", err)
	}
	if len(store.scheduled) != 0 {
		t.Fatalf("запланировано %d, want 0", len(store.scheduled))
	}
}

func TestScheduleRejectsInvalid(t *testing.T) {
	store, pub := &stubStore{}, &stubPublisher{}
	r := validRequest()
	r.Email = ""
	if _, err := newScheduler(store, pub).Schedule(context.Background(), r); !errors.Is(err, domain.ErrInvalidReminder) {
		t.Fatalf("ошибка = %v, want ErrInvalidReminder", err)
	}
}

func TestCancelMissing(t *testing.T) {
	// пустой store: напоминания не было — идемпотентный MISSING
	store, pub := &stubStore{}, &stubPublisher{}
	st, err := newScheduler(store, pub).Cancel(context.Background(), "b-нет")
	if err != nil {
		t.Fatal(err)
	}
	if st != "MISSING" {
		t.Fatalf("status = %q, want MISSING", st)
	}
}

func TestCancelFound(t *testing.T) {
	store, pub := &stubStore{cancelFound: true}, &stubPublisher{}
	st, err := newScheduler(store, pub).Cancel(context.Background(), "b-1")
	if err != nil {
		t.Fatal(err)
	}
	if st != string(domain.StatusCancelled) {
		t.Fatalf("status = %q, want CANCELLED", st)
	}
	if len(store.cancelled) != 1 || store.cancelled[0] != "b-1" {
		t.Fatalf("cancelled = %v, want [b-1]", store.cancelled)
	}
}

func TestCancelEmptyBookingID(t *testing.T) {
	store, pub := &stubStore{}, &stubPublisher{}
	if _, err := newScheduler(store, pub).Cancel(context.Background(), ""); !errors.Is(err, domain.ErrEmptyBookingID) {
		t.Fatalf("ошибка = %v, want ErrEmptyBookingID", err)
	}
}

func TestTickPublishesAndMarks(t *testing.T) {
	store, pub := &stubStore{}, &stubPublisher{}
	store.due = []domain.Reminder{{
		BookingID: "b-1", UserID: "u-1", Email: "u@cine.local",
		MovieTitle: "Дюна", Hall: "Красный", Seats: []string{"5-7"},
	}}
	newScheduler(store, pub).Tick(context.Background())

	if len(pub.published) != 1 {
		t.Fatalf("опубликовано %d, want 1", len(pub.published))
	}
	if !pub.published[0].RemindedAt.Equal(fixedNow) {
		t.Fatalf("RemindedAt = %v, want %v", pub.published[0].RemindedAt, fixedNow)
	}
	if len(store.markSent) != 1 || store.markSent[0] != "b-1" {
		t.Fatalf("markSent = %v, want [b-1]", store.markSent)
	}
}

func TestTickPublishFailureKeepsScheduled(t *testing.T) {
	store, pub := &stubStore{}, &stubPublisher{err: errors.New("брокер молчит")}
	store.due = []domain.Reminder{{BookingID: "b-1", UserID: "u-1", Email: "u@cine.local"}}
	newScheduler(store, pub).Tick(context.Background())

	if len(store.markSent) != 0 {
		t.Fatalf("markSent = %v, want пусто: без публикации SENT не ставится", store.markSent)
	}
}

func TestTickDueErrorIsQuiet(t *testing.T) {
	store, pub := &stubStore{dueErr: errors.New("база упала")}, &stubPublisher{}
	newScheduler(store, pub).Tick(context.Background()) // не паникует
	if len(pub.published) != 0 {
		t.Fatalf("опубликовано %d, want 0", len(pub.published))
	}
}

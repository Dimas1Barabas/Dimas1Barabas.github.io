package service

import (
	"context"
	"errors"
	"testing"

	"analytics-service/internal/domain"
)

// fakeStore — стаб порта: помнит, что применяли, и умеет падать.
type fakeStore struct {
	web      []domain.Event
	paid     []string
	verdicts []bool
	err      error
}

func (f *fakeStore) ApplyWebEvent(_ context.Context, e domain.Event) error {
	if f.err != nil {
		return f.err
	}
	f.web = append(f.web, e)
	return nil
}

func (f *fakeStore) ApplyBookingPaid(_ context.Context, bookingID, _ string) error {
	if f.err != nil {
		return f.err
	}
	f.paid = append(f.paid, bookingID)
	return nil
}

func (f *fakeStore) ApplyBookingVerdict(_ context.Context, _ string, confirmed bool) error {
	if f.err != nil {
		return f.err
	}
	f.verdicts = append(f.verdicts, confirmed)
	return nil
}

func (f *fakeStore) Insights(context.Context) (domain.Insights, error) {
	return domain.Insights{}, nil
}

func TestHandleWebEventValid(t *testing.T) {
	store := &fakeStore{}
	svc := NewAnalyzer(store)
	ctx := context.Background()

	cases := []domain.Event{
		{AID: "a", Type: domain.EventPageView, Route: "home"},
		{AID: "a", Type: domain.EventPageDwell, Route: "pay", MS: 5000},
		{AID: "a", Type: domain.EventBookingModalOpen, MovieID: "m-1"},
		{AID: "a", Type: domain.EventSessionSelected, MovieID: "m-1", SessionID: "s-1"},
		{AID: "a", Type: domain.EventSeatsSelected, SessionID: "s-1", Count: 3},
		{AID: "a", Type: domain.EventSeatClick, SessionID: "s-1", Seat: "5-7", Hall: "Красный"},
		{AID: "a", Type: domain.EventBookingCreated, BookingID: "b-1"},
		{AID: "a", Type: domain.EventPaymentOpened, BookingID: "b-1"},
		{AID: "a", Type: domain.EventModalDwell, MovieID: "m-1", Deepest: "created", MS: 42000},
	}
	for _, e := range cases {
		if err := svc.HandleWebEvent(ctx, e); err != nil {
			t.Fatalf("%s должен проходить, получили %v", e.Type, err)
		}
	}
	if len(store.web) != len(cases) {
		t.Fatalf("хранилище увидело %d событий из %d", len(store.web), len(cases))
	}
}

func TestHandleWebEventPoison(t *testing.T) {
	store := &fakeStore{}
	svc := NewAnalyzer(store)
	ctx := context.Background()

	cases := []domain.Event{
		{Type: domain.EventPageView, Route: "home"},                     // без aid
		{AID: "a", Type: domain.EventPageView},                          // без маршрута
		{AID: "a", Type: domain.EventPageDwell, Route: "home", MS: -1},  // отрицательное время
		{AID: "a", Type: domain.EventBookingModalOpen},                  // без фильма
		{AID: "a", Type: domain.EventSeatsSelected, SessionID: "s", Count: 0},
		{AID: "a", Type: domain.EventSeatClick, SessionID: "s", Seat: "5-7"}, // без зала
		{AID: "a", Type: domain.EventModalDwell, MovieID: "m", Deepest: "доуписался"},
		{AID: "a", Type: domain.EventType("миг")},                       // неизвестный тип
	}
	for _, e := range cases {
		err := svc.HandleWebEvent(ctx, e)
		if !errors.Is(err, domain.ErrInvalidEvent) {
			t.Fatalf("%+v: ждём ErrInvalidEvent, получили %v", e, err)
		}
	}
	if len(store.web) != 0 {
		t.Fatalf("битые события не должны доходить до хранилища: %+v", store.web)
	}
}

func TestBrokerEvents(t *testing.T) {
	store := &fakeStore{}
	svc := NewAnalyzer(store)
	ctx := context.Background()

	if err := svc.HandleBookingPaid(ctx, "b-1", "m-1"); err != nil {
		t.Fatalf("paid: %v", err)
	}
	if err := svc.HandleBookingVerdict(ctx, "b-1", true); err != nil {
		t.Fatalf("verdict: %v", err)
	}
	if store.paid != nil && store.paid[0] != "b-1" {
		t.Fatalf("paid прошёл мимо: %+v", store.paid)
	}
	if len(store.verdicts) != 1 || !store.verdicts[0] {
		t.Fatalf("verdict потерялся: %+v", store.verdicts)
	}

	// без идентификаторов — poison
	if err := svc.HandleBookingPaid(ctx, "", "m-1"); !errors.Is(err, domain.ErrInvalidEvent) {
		t.Fatalf("paid без брони: ждём ErrInvalidEvent, получили %v", err)
	}
	if err := svc.HandleBookingVerdict(ctx, "", true); !errors.Is(err, domain.ErrInvalidEvent) {
		t.Fatalf("verdict без брони: ждём ErrInvalidEvent, получили %v", err)
	}
}

func TestStoreErrorPropagates(t *testing.T) {
	boom := errors.New("хранилище мертво")
	svc := NewAnalyzer(&fakeStore{err: boom})
	if err := svc.HandleWebEvent(context.Background(), domain.Event{
		AID: "a", Type: domain.EventPageView, Route: "home",
	}); !errors.Is(err, boom) {
		t.Fatalf("ошибка хранилища должна всплыть вызывающему: %v", err)
	}
}

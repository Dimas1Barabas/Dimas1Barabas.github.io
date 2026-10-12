package memory

import (
	"context"
	"testing"

	"analytics-service/internal/domain"
)

func TestAggregatesAndInsights(t *testing.T) {
	s := NewStore()
	ctx := context.Background()

	events := []domain.Event{
		{AID: "a", Type: domain.EventBookingModalOpen, MovieID: "m-1"},
		{AID: "a", Type: domain.EventBookingModalOpen, MovieID: "m-1"},
		{AID: "a", Type: domain.EventBookingModalOpen, MovieID: "m-2"},
		{AID: "a", Type: domain.EventSessionSelected, MovieID: "m-1", SessionID: "s-1"},
		{AID: "a", Type: domain.EventSeatClick, SessionID: "s-1", Seat: "5-7", Hall: "Красный"},
		{AID: "a", Type: domain.EventSeatClick, SessionID: "s-1", Seat: "5-7", Hall: "Красный"},
		{AID: "a", Type: domain.EventPageView, Route: "home"},
		{AID: "a", Type: domain.EventPageDwell, Route: "home", MS: 1000},
		{AID: "a", Type: domain.EventModalDwell, MovieID: "m-1", Deepest: "session", MS: 2000},
	}
	for _, e := range events {
		if err := s.ApplyWebEvent(ctx, e); err != nil {
			t.Fatalf("%s: %v", e.Type, err)
		}
	}
	_ = s.ApplyBookingPaid(ctx, "b-1", "m-1")
	_ = s.ApplyBookingVerdict(ctx, "b-1", true)

	ins, err := s.Insights(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// воронка: только шаги с событиями, в порядке пути
	if len(ins.Funnel) != 4 {
		t.Fatalf("4 шага воронки, получили %d: %+v", len(ins.Funnel), ins.Funnel)
	}
	// m-1 дважды + m-2 раз = три открытия модалки
	if ins.Funnel[0].Step != domain.StepModalOpen || ins.Funnel[0].Count != 3 {
		t.Fatalf("modal_open=3: %+v", ins.Funnel[0])
	}
	if ins.Funnel[3].Step != domain.StepConfirmed {
		t.Fatalf("воронка заканчивается confirmed: %+v", ins.Funnel)
	}

	// фильмы по интересу: m-1 (2) выше m-2 (1)
	if ins.Movies[0].MovieID != "m-1" || ins.Movies[0].Opens != 2 || ins.Movies[0].Bookings != 1 {
		t.Fatalf("m-1: %+v", ins.Movies[0])
	}

	// места: 5-7 дважды
	if len(ins.Seats) != 1 || ins.Seats[0].Clicks != 2 {
		t.Fatalf("места: %+v", ins.Seats)
	}

	// страницы и модалка
	if ins.Pages[0].Route != "home" || ins.Pages[0].Views != 1 || ins.Pages[0].TotalMS != 1000 {
		t.Fatalf("страницы: %+v", ins.Pages)
	}
	if ins.Modal[0].Deepest != "session" || ins.Modal[0].Events != 1 || ins.Modal[0].TotalMS != 2000 {
		t.Fatalf("модалка: %+v", ins.Modal)
	}
}

func TestEmptyInsights(t *testing.T) {
	ins, err := NewStore().Insights(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(ins.Funnel) != 0 || len(ins.Movies) != 0 {
		t.Fatalf("пустое хранилище = пустая витрина: %+v", ins)
	}
}

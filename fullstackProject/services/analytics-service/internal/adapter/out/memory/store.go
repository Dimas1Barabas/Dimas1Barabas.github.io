// Package memory — AnalyticsStore-адаптер в памяти: карта агрегатов
// под мьютексом. Дефолт STORAGE=memory: сервис стартует и копит
// статистику, пока не перезапустят (для демо-стенда этого хватает;
// персистентный вариант — postgres).
package memory

import (
	"context"
	"sort"
	"sync"

	"analytics-service/internal/domain"
)

type store struct {
	mu      sync.Mutex
	funnel  map[domain.FunnelStep]int64
	movies  map[string]*domain.MovieInterest
	pages   map[string]*domain.PageStat
	seats   map[string]*domain.SeatHeat // ключ hall + "|" + seat
	modal   map[string]*domain.ModalStat
}

// NewStore собирает пустое хранилище в памяти.
func NewStore() domain.AnalyticsStore {
	return &store{
		funnel: map[domain.FunnelStep]int64{},
		movies: map[string]*domain.MovieInterest{},
		pages:  map[string]*domain.PageStat{},
		seats:  map[string]*domain.SeatHeat{},
		modal:  map[string]*domain.ModalStat{},
	}
}

// ApplyWebEvent раскладывает событие по агрегатам: воронка — по шагу,
// интерес/время — к фильму, страницы и места — по ключам.
func (s *store) ApplyWebEvent(_ context.Context, e domain.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if step, ok := domain.FunnelStepOf[e.Type]; ok {
		s.funnel[step]++
	}

	switch e.Type {
	case domain.EventBookingModalOpen:
		m := s.movie(e.MovieID)
		m.Opens++
	case domain.EventModalDwell:
		// фильм уже посчитан открытием модалки; dwell копится по глубине
		st := s.modalDepth(e.Deepest)
		st.Events++
		st.TotalMS += e.MS
	case domain.EventPageView:
		p := s.page(e.Route)
		p.Views++
	case domain.EventPageDwell:
		p := s.page(e.Route)
		p.TotalMS += e.MS
	case domain.EventSeatClick:
		key := e.Hall + "|" + e.Seat
		if h, ok := s.seats[key]; ok {
			h.Clicks++
		} else {
			s.seats[key] = &domain.SeatHeat{Hall: e.Hall, Seat: e.Seat, Clicks: 1}
		}
	}
	return nil
}

// ApplyBookingPaid — воронка paid + бронирование фильма.
func (s *store) ApplyBookingPaid(_ context.Context, _, movieID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.funnel[domain.StepPaid]++
	s.movie(movieID).Bookings++
	return nil
}

// ApplyBookingVerdict — воронка confirmed/failed.
func (s *store) ApplyBookingVerdict(_ context.Context, _ string, confirmed bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if confirmed {
		s.funnel[domain.StepConfirmed]++
	} else {
		s.funnel[domain.StepFailed]++
	}
	return nil
}

// Insights — витрина: воронка в порядке пути, фильмы по интересу,
// страницы по маршрутам, места по кликам.
func (s *store) Insights(_ context.Context) (domain.Insights, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	order := []domain.FunnelStep{
		domain.StepModalOpen, domain.StepSessionSelected, domain.StepSeatsSelected,
		domain.StepBookingCreated, domain.StepPaymentOpened, domain.StepPaid,
		domain.StepConfirmed, domain.StepFailed,
	}
	funnel := make([]domain.FunnelRow, 0, len(order))
	for _, step := range order {
		if count, ok := s.funnel[step]; ok && count > 0 {
			funnel = append(funnel, domain.FunnelRow{Step: step, Count: count})
		}
	}

	movies := make([]domain.MovieInterest, 0, len(s.movies))
	for _, m := range s.movies {
		movies = append(movies, *m)
	}
	sort.Slice(movies, func(i, j int) bool {
		if movies[i].Opens != movies[j].Opens {
			return movies[i].Opens > movies[j].Opens
		}
		return movies[i].MovieID < movies[j].MovieID
	})

	pages := make([]domain.PageStat, 0, len(s.pages))
	for _, p := range s.pages {
		pages = append(pages, *p)
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Route < pages[j].Route })

	seats := make([]domain.SeatHeat, 0, len(s.seats))
	for _, h := range s.seats {
		seats = append(seats, *h)
	}
	sort.Slice(seats, func(i, j int) bool {
		if seats[i].Clicks != seats[j].Clicks {
			return seats[i].Clicks > seats[j].Clicks
		}
		if seats[i].Hall != seats[j].Hall {
			return seats[i].Hall < seats[j].Hall
		}
		return seats[i].Seat < seats[j].Seat
	})

	modal := make([]domain.ModalStat, 0, len(s.modal))
	for _, st := range s.modal {
		modal = append(modal, *st)
	}
	sort.Slice(modal, func(i, j int) bool { return modal[i].Deepest < modal[j].Deepest })

	return domain.Insights{
		Funnel: funnel, Movies: movies, Pages: pages, Seats: seats, Modal: modal,
	}, nil
}

// movie достаёт агрегат фильма, создавая при первом обращении.
func (s *store) movie(id string) *domain.MovieInterest {
	if m, ok := s.movies[id]; ok {
		return m
	}
	m := &domain.MovieInterest{MovieID: id}
	s.movies[id] = m
	return m
}

// page достаёт агрегат маршрута.
func (s *store) page(route string) *domain.PageStat {
	if p, ok := s.pages[route]; ok {
		return p
	}
	p := &domain.PageStat{Route: route}
	s.pages[route] = p
	return p
}

// modalDepth достаёт агрегат глубины пути в модалке.
func (s *store) modalDepth(deepest string) *domain.ModalStat {
	if st, ok := s.modal[deepest]; ok {
		return st
	}
	st := &domain.ModalStat{Deepest: deepest}
	s.modal[deepest] = st
	return st
}

// Package httpapi — входящий адаптер: витрина «Поведение» и служебные
// эндпоинты. /insights читает прокси админ-страницы веба (через API),
// health — compose-проба, /metrics — Prometheus.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"analytics-service/internal/domain"
	"analytics-service/internal/logging"
	"analytics-service/internal/service"
)

// Start поднимает HTTP-сервер в горутине; Shutdown — обязанность main.
// metricsHandler — prometheus-выгрузка адаптера out/prom.
func Start(addr string, svc *service.Analyzer, metricsHandler http.Handler) *http.Server {
	srv := New(addr, svc, metricsHandler)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logging.Error("http: %v", err)
		}
	}()
	logging.Info("http: /health, /insights и /metrics на %s", addr)
	return srv
}

// New собирает сервер без запуска — для main и тестов.
func New(addr string, svc *service.Analyzer, metricsHandler http.Handler) *http.Server {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.Handle("/metrics", metricsHandler)

	// витрина «Поведение»: воронка, интерес к фильмам, страницы,
	// тепловая карта мест, время в модалке — одним ответом
	mux.HandleFunc("/insights", func(w http.ResponseWriter, r *http.Request) {
		insights, err := svc.Insights(r.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, toView(insights))
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"service":   "analytics-service",
			"endpoints": []string{"/health", "/insights", "/metrics"},
		})
	})

	return &http.Server{Addr: addr, Handler: mux}
}

// insightsView — проводник домена в JSON: средние считаем здесь,
// фронт получает готовые числа (avgDwellMs, conversionPercent).
type insightsView struct {
	Funnel []funnelRowView `json:"funnel"`
	Movies []movieView     `json:"movies"`
	Pages  []pageView      `json:"pages"`
	Seats  []seatView      `json:"seats"`
	Modal  []modalView     `json:"modal"`
}

type funnelRowView struct {
	Step  string `json:"step"`
	Count int64  `json:"count"`
}

type movieView struct {
	MovieID           string `json:"movieId"`
	Opens             int64  `json:"opens"`
	Bookings          int64  `json:"bookings"`
	ConversionPercent int64  `json:"conversionPercent"` // bookings/opens, %
}

type pageView struct {
	Route      string `json:"route"`
	Views      int64  `json:"views"`
	AvgDwellMS int64  `json:"avgDwellMs"`
}

type seatView struct {
	Hall   string `json:"hall"`
	Seat   string `json:"seat"`
	Clicks int64  `json:"clicks"`
}

type modalView struct {
	Deepest  string `json:"deepest"`
	Events   int64  `json:"events"`
	AvgMS    int64  `json:"avgMs"`
}

func toView(d domain.Insights) insightsView {
	out := insightsView{
		Funnel: make([]funnelRowView, 0, len(d.Funnel)),
		Movies: make([]movieView, 0, len(d.Movies)),
		Pages:  make([]pageView, 0, len(d.Pages)),
		Seats:  make([]seatView, 0, len(d.Seats)),
		Modal:  make([]modalView, 0, len(d.Modal)),
	}
	for _, row := range d.Funnel {
		out.Funnel = append(out.Funnel, funnelRowView{Step: string(row.Step), Count: row.Count})
	}
	for _, m := range d.Movies {
		// конверсия «интерес → бронь»: без открытий деления нет — 0
		var conversion int64
		if m.Opens > 0 {
			conversion = m.Bookings * 100 / m.Opens
		}
		out.Movies = append(out.Movies, movieView{
			MovieID: m.MovieID, Opens: m.Opens, Bookings: m.Bookings,
			ConversionPercent: conversion,
		})
	}
	for _, p := range d.Pages {
		var avg int64
		if p.Views > 0 {
			avg = p.TotalMS / p.Views
		}
		out.Pages = append(out.Pages, pageView{Route: p.Route, Views: p.Views, AvgDwellMS: avg})
	}
	for _, s := range d.Seats {
		out.Seats = append(out.Seats, seatView{Hall: s.Hall, Seat: s.Seat, Clicks: s.Clicks})
	}
	for _, m := range d.Modal {
		var avg int64
		if m.Events > 0 {
			avg = m.TotalMS / m.Events
		}
		out.Modal = append(out.Modal, modalView{Deepest: m.Deepest, Events: m.Events, AvgMS: avg})
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

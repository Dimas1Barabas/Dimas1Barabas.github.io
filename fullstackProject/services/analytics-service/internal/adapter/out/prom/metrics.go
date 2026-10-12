// Package prom — счётчики Аналитика для Prometheus. Как у соседей,
// метрики считает адаптер на границе: события, лёгшие в агрегаты,
// и сбои обработки; в домен сквозная забота не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	events *prometheus.CounterVec // routing key события
	errors prometheus.Counter     // сбои обработки (транзиентные, уйдут в retry)
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		events: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_analytics_events_total",
			Help: "Behavior and booking events folded into aggregates",
		}, []string{"routing_key"}),
		errors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_analytics_errors_total",
			Help: "Transient processing failures (store down, event retried)",
		}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.events, m.errors,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Event — событие легло в агрегаты: счётчик по routing key
// (analytics.event | booking.created | booking.processed).
func (m *Metrics) Event(routingKey string) {
	m.events.WithLabelValues(routingKey).Inc()
}

// Error — транзиентный сбой обработки события.
func (m *Metrics) Error() {
	m.errors.Inc()
}

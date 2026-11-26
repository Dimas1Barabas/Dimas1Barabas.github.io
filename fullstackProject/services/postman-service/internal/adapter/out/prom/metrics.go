// Package prom — счётчики «Почтальона» для Prometheus. Как у соседей,
// метрики считает адаптер на границе: принятые события, доставки
// партнёрам, неудачи и DLQ, перепосылки из витрины; в домен сквозная
// забота не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	events    *prometheus.CounterVec // принятые из брокера события по типу
	delivered *prometheus.CounterVec // доставленные партнёрам вебхуки
	failed    *prometheus.CounterVec // неудачные попытки доставки
	dead      prometheus.Counter     // проводки в DLQ (попытки кончились)
	replayed  prometheus.Counter     // перепосылки из витрины
	errors    prometheus.Counter     // сбои обработки событий (транзиентные, уйдут в retry)
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		events: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_postman_events_total",
			Help: "Booking events accepted from the cinema exchange",
		}, []string{"routing_key"}),
		delivered: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_postman_delivered_total",
			Help: "Webhooks delivered to partners (2xx)",
		}, []string{"event_type"}),
		failed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_postman_failed_total",
			Help: "Failed webhook delivery attempts (retry scheduled)",
		}, []string{"event_type"}),
		dead: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_postman_dead_total",
			Help: "Deliveries moved to DLQ after exhausting attempts",
		}),
		replayed: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_postman_replayed_total",
			Help: "Deliveries requeued from the admin showcase",
		}),
		errors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cine_postman_errors_total",
			Help: "Transient processing failures (store down, event retried)",
		}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.events, m.delivered, m.failed, m.dead, m.replayed, m.errors,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Event — событие принято из брокера и развернуто в доставки.
func (m *Metrics) Event(routingKey string) { m.events.WithLabelValues(routingKey).Inc() }

// Delivered — партнёр ответил 2xx.
func (m *Metrics) Delivered(eventType string) { m.delivered.WithLabelValues(eventType).Inc() }

// Failed — попытка не удалась, ретрай по расписанию.
func (m *Metrics) Failed(eventType string) { m.failed.WithLabelValues(eventType).Inc() }

// Dead — доставка уехала в DLQ.
func (m *Metrics) Dead() { m.dead.Inc() }

// Replayed — витрина вернула доставку в очередь.
func (m *Metrics) Replayed() { m.replayed.Inc() }

// Error — транзиентный сбой обработки события.
func (m *Metrics) Error() { m.errors.Inc() }

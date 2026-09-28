// Package prom — счётчики «Привратника» для Prometheus. Синхронный
// сервис без своих событий, поэтому метрики считает входящий gRPC-адаптер
// на границе вызова: решение (allowed/denied), сбой хранилища и длительность
// Check. Сквозная забота — в домен не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	checks   *prometheus.CounterVec   // action × decision
	errors   *prometheus.CounterVec   // action
	duration *prometheus.HistogramVec // action
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		checks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_ratelimiter_checks_total",
			Help: "Token bucket checks by action and verdict",
		}, []string{"action", "decision"}),
		errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_ratelimiter_errors_total",
			Help: "Bucket store failures by action",
		}, []string{"action"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "cine_ratelimiter_check_duration_seconds",
			Help: "Duration of a single Check call",
			Buckets: []float64{
				0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
			},
		}, []string{"action"}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.checks, m.errors, m.duration,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Check фиксирует вердикт корзины и длительность обращения к ней.
func (m *Metrics) Check(action string, allowed bool, seconds float64) {
	decision := "denied"
	if allowed {
		decision = "allowed"
	}
	m.checks.WithLabelValues(action, decision).Inc()
	m.duration.WithLabelValues(action).Observe(seconds)
}

// Error — хранилище корзин ответило сбоем (RPC Internal).
func (m *Metrics) Error(action string) {
	m.errors.WithLabelValues(action).Inc()
}

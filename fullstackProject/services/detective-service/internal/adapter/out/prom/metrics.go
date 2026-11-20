// Package prom — счётчики «Детектива» для Prometheus. Синхронный
// сервис без своих событий, поэтому метрики считает входящий gRPC-адаптер
// на границе вызова: вердикты скоринга, решения админов, сбои хранилища
// и длительность Score. Сквозная забота — в домен не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	scores   *prometheus.CounterVec   // вердикт скоринга
	resolves *prometheus.CounterVec   // финальный статус решения
	errors   *prometheus.CounterVec   // метод
	duration *prometheus.HistogramVec // Score
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		scores: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_detective_scores_total",
			Help: "Fraud scoring verdicts",
		}, []string{"verdict"}),
		resolves: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_detective_resolves_total",
			Help: "Manual review decisions by final status",
		}, []string{"status"}),
		errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_detective_errors_total",
			Help: "Decision store failures by rpc",
		}, []string{"rpc"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "cine_detective_score_duration_seconds",
			Help: "Duration of a single Score call",
			Buckets: []float64{
				0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
			},
		}, []string{"rpc"}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.scores, m.resolves, m.errors, m.duration,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Score фиксирует вердикт скоринга и длительность обращения к хранилищу.
func (m *Metrics) Score(verdict string, seconds float64) {
	m.scores.WithLabelValues(verdict).Inc()
	m.duration.WithLabelValues("Score").Observe(seconds)
}

// Resolve фиксирует решение человека.
func (m *Metrics) Resolve(status string) {
	m.resolves.WithLabelValues(status).Inc()
}

// Error — хранилище решений ответило сбоем (RPC Internal).
func (m *Metrics) ScoreError()   { m.errors.WithLabelValues("Score").Inc() }
func (m *Metrics) ResolveError() { m.errors.WithLabelValues("Resolve").Inc() }

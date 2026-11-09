// Package prom — счётчики «Суфлёра» для Prometheus. Синхронный сервис
// без своих событий, поэтому метрики считают входящие адаптеры на
// границе вызова: вердикты по причинам, правки/удаления, сбои
// хранилища и длительности. Сквозная забота — в домен не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	evaluates *prometheus.CounterVec   // key × reason
	mutations *prometheus.CounterVec   // op (upsert | delete)
	reports   *prometheus.CounterVec   // kind (exposure | conversion)
	errors    *prometheus.CounterVec   // op
	duration  *prometheus.HistogramVec // op
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		evaluates: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_flags_evaluates_total",
			Help: "Flag verdicts by flag key and reason",
		}, []string{"key", "reason"}),
		mutations: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_flags_mutations_total",
			Help: "Flag mutations by operation",
		}, []string{"op"}),
		reports: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_flags_reports_total",
			Help: "Experiment metric reports by kind (exposure | conversion)",
		}, []string{"kind"}),
		errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_flags_errors_total",
			Help: "Flag store failures by operation",
		}, []string{"op"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "cine_flags_op_duration_seconds",
			Help: "Duration of a single Flags RPC",
			Buckets: []float64{
				0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
			},
		}, []string{"op"}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.evaluates, m.mutations, m.reports, m.errors, m.duration,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// Evaluate фиксирует вердикт флага и длительность обращения.
func (m *Metrics) Evaluate(key, reason string, seconds float64) {
	m.evaluates.WithLabelValues(key, reason).Inc()
	m.duration.WithLabelValues("evaluate").Observe(seconds)
}

// Upsert — правка флага (создание или изменение состояния).
func (m *Metrics) Upsert(seconds float64) {
	m.mutations.WithLabelValues("upsert").Inc()
	m.duration.WithLabelValues("upsert").Observe(seconds)
}

// Delete — удаление флага.
func (m *Metrics) Delete(seconds float64) {
	m.mutations.WithLabelValues("delete").Inc()
	m.duration.WithLabelValues("delete").Observe(seconds)
}

// List — снимок всех флагов (опрос кэша API): считаем только
// длительность, счётчик опросов неинформативен.
func (m *Metrics) List(seconds float64) {
	m.duration.WithLabelValues("list").Observe(seconds)
}

// Report — отчёт метрики эксперимента (exposure | conversion).
func (m *Metrics) Report(kind string, seconds float64) {
	m.reports.WithLabelValues(kind).Inc()
	m.duration.WithLabelValues("report_" + kind).Observe(seconds)
}

// Error — хранилище ответило сбоем (RPC Internal).
func (m *Metrics) Error(op string) {
	m.errors.WithLabelValues(op).Inc()
}

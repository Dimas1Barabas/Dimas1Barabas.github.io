// Package prom — счётчики КиноСоветника для Prometheus. Метрики ведут
// входящие адаптеры на границах вызова: топы афиши по gRPC и сигналы
// зрителя из RabbitMQ. Сквозная забота — в домен не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	tops     *prometheus.CounterVec   // result=ok|error
	duration prometheus.Histogram     // длительность GetRecommendations
	signals  *prometheus.CounterVec   // kind=booking|review
	errors   *prometheus.CounterVec   // source=grpc|amqp
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		tops: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_recommendation_tops_total",
			Help: "Personal top-lists served to the API",
		}, []string{"result"}),
		duration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "cine_recommendation_top_duration_seconds",
			Help: "Duration of a single GetRecommendations call",
			Buckets: []float64{
				0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
			},
		}),
		signals: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_recommendation_signals_total",
			Help: "Viewer signals applied to taste profiles",
		}, []string{"kind"}),
		errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_recommendation_errors_total",
			Help: "Failures by source (store unreachable, event rejected)",
		}, []string{"source"}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.tops, m.duration, m.signals, m.errors,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// TopOk — топ отдан: счётчик и длительность.
func (m *Metrics) TopOk(seconds float64) {
	m.tops.WithLabelValues("ok").Inc()
	m.duration.Observe(seconds)
}

// TopError — хранилище сигналов ответило сбоем (RPC Internal).
func (m *Metrics) TopError(seconds float64) {
	m.tops.WithLabelValues("error").Inc()
	m.duration.Observe(seconds)
}

// Signal — доменный сигнал лёг в профиль зрителя (booking/review).
func (m *Metrics) Signal(kind string) {
	m.signals.WithLabelValues(kind).Inc()
}

// AmqpError — транзиентный сбой обработки события (уйдёт в retry).
func (m *Metrics) AmqpError() {
	m.errors.WithLabelValues("amqp").Inc()
}

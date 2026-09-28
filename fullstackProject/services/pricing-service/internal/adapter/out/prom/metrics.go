// Package prom — счётчики Тарификатора для Prometheus. Как и у Привратника,
// метрики считает входящий адаптер на границе вызова: котировки gRPC
// (результат, цена, длительность) и события спроса из RabbitMQ.
// Сквозная забота — в домен не проваливается.
package prom

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	quotes   *prometheus.CounterVec   // result=ok|error
	prices   prometheus.Histogram      // распределение насчитанных цен
	duration prometheus.Histogram      // длительность Quote
	demand   *prometheus.CounterVec   // change=held|released
	errors   *prometheus.CounterVec   // source=grpc|amqp
}

// New собирает реестр: собственный (не глобальный) — чистые ряды в тестах.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		registry: reg,
		quotes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_pricing_quotes_total",
			Help: "Seat price quotes served to the API",
		}, []string{"result"}),
		prices: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "cine_pricing_quote_price_rub",
			Help: "Distribution of quoted seat prices (rubles)",
			Buckets: []float64{
				100, 150, 200, 250, 300, 400, 500, 650, 800, 1000, 1250, 1500, 2000, 3000,
			},
		}),
		duration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "cine_pricing_quote_duration_seconds",
			Help: "Duration of a single Quote call",
			Buckets: []float64{
				0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
			},
		}),
		demand: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_pricing_demand_events_total",
			Help: "Demand projection events applied by change kind",
		}, []string{"change"}),
		errors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cine_pricing_errors_total",
			Help: "Failures by source (store unreachable, event rejected)",
		}, []string{"source"}),
	}
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		m.quotes, m.prices, m.duration, m.demand, m.errors,
	)
	return m
}

// Handler отдаёт exposition-текст для mux.Handle("/metrics", ...).
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{})
}

// QuoteOk — котировка отдана: счётчик, цена и длительность.
func (m *Metrics) QuoteOk(priceRub int, seconds float64) {
	m.quotes.WithLabelValues("ok").Inc()
	m.prices.Observe(float64(priceRub))
	m.duration.Observe(seconds)
}

// QuoteError — хранилище спроса ответило сбоем (RPC Internal).
func (m *Metrics) QuoteError(seconds float64) {
	m.quotes.WithLabelValues("error").Inc()
	m.duration.Observe(seconds)
}

// Demand — событие спроса легло в проекцию (held — резерв, released — возврат).
func (m *Metrics) Demand(held bool) {
	change := "released"
	if held {
		change = "held"
	}
	m.demand.WithLabelValues(change).Inc()
}

// Error — сбой обработки события спроса (транзиентный, уйдёт в retry).
func (m *Metrics) Error() {
	m.errors.WithLabelValues("amqp").Inc()
}
